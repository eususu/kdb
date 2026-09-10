import type { ErrorRequestHandler } from 'express';
import type { ExtractedDocument, OcrResult } from './lib/types.ts';
import { errorMessage } from './lib/types.ts';
import { createHash } from 'node:crypto';
import express from 'express';
import multer from 'multer';

import { config, SAFE_ID } from './config.ts';
import * as tika from './lib/tika.ts';
import * as meili from './lib/meili.ts';
import * as ocr from './lib/ocr.ts';
import { buildChunks } from './lib/chunk.ts';
import { toAsciiSlug } from './lib/slug.ts';

const app = express();
app.use(express.json());

// 파일을 메모리에 일시 저장하여 스트림으로 다루기 위한 설정
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes }
});

class HttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

/** Index name comes from the request, falling back to DEFAULT_INDEX. */
function resolveIndex(value: unknown) {
    const name = String(value ?? '').trim() || config.defaultIndex;
    if (!SAFE_ID.test(name)) {
        throw new HttpError(400, `index 이름은 영숫자, 하이픈, 언더스코어만 쓸 수 있습니다. 받은 값: ${name}`);
    }
    return name;
}

/** A merged chunk can span several pages, so any OCR'd page in the range taints it. */
function rangeIncludesOcr(pageStart: number, pageEnd: number | null, ocrPages: Set<number>) {
    if (ocrPages.size === 0) return false;
    for (let page = pageStart; page <= (pageEnd ?? pageStart); page += 1) {
        if (ocrPages.has(page)) return true;
    }
    return false;
}

const OCR_MODES = new Set(['auto', 'off', 'force']);

function resolveOcrMode(value: unknown) {
    const mode = String(value ?? 'auto').trim().toLowerCase() || 'auto';
    if (!OCR_MODES.has(mode)) {
        throw new HttpError(400, `ocr 는 ${[...OCR_MODES].join(', ')} 중 하나여야 합니다. 받은 값: ${mode}`);
    }
    return mode;
}

function isPdf(contentType: string | null, filename: string) {
    return /pdf/i.test(contentType ?? '') || /\.pdf$/i.test(filename);
}

/**
 * Fills in text for pages Tika could not read, by rendering them and running the
 * Ollama vision model over the images.
 *
 * @returns {Promise<{pages: string[]|null, fullText: string, info: object|null}>}
 */
async function applyOcr({ buffer, filename, extracted, mode }: { buffer: Buffer; filename: string; extracted: ExtractedDocument; mode: string }): Promise<OcrResult> {
    const skip = { pages: extracted.pages, fullText: extracted.fullText, info: null };
    if (mode === 'off' || !config.ocr.enabled) return skip;

    const { minChars } = config.ocr;
    const contentType = extracted.contentType ?? '';

    // A directly uploaded image has no page structure; transcribe the file itself.
    if (/^image\//i.test(contentType)) {
        if (mode !== 'force' && extracted.fullText.length >= minChars) return skip;
        try {
            const text = await ocr.transcribeImage(buffer);
            if (!text) return skip;
            return {
                pages: null,
                fullText: text,
                info: { applied: true, target: 'image', pages: [], failures: [], skipped: 0 }
            };
        } catch (error) {
            console.warn(`[OCR 실패] ${filename}: ${errorMessage(error)}`);
            return { ...skip, info: { applied: false, target: 'image', error: errorMessage(error) } };
        }
    }

    if (!isPdf(contentType, filename)) return skip;

    // Work out which pages need help. Tika returning nothing at all means every page does.
    let pages = extracted.pages;
    if (!pages || pages.length === 0) {
        const pageCount = await ocr.getPdfPageCount(buffer);
        if (!pageCount) return skip;
        pages = Array.from({ length: pageCount }, () => '');
    }

    const candidates = pages
        .map((text, index) => ({ page: index + 1, length: text.length }))
        .filter(({ length }) => mode === 'force' || length < minChars)
        .map(({ page }) => page);

    if (candidates.length === 0) return skip;

    console.log(`[OCR 시작] ${filename}: ${candidates.length}개 페이지 (모델 ${config.ocr.model})`);
    const started = Date.now();

    let result;
    try {
        result = await ocr.ocrPdfPages(buffer, candidates);
    } catch (error) {
        console.warn(`[OCR 실패] ${filename}: ${errorMessage(error)}`);
        return { ...skip, info: { applied: false, target: 'pdf', error: errorMessage(error) } };
    }

    const merged = [...pages];
    const replaced = [];
    for (const [pageNumber, text] of result.texts) {
        const original = merged[pageNumber - 1] ?? '';
        // In auto mode, never trade extracted text for a shorter OCR guess. Only `force`
        // is allowed to overwrite text that Tika read successfully.
        if (mode !== 'force' && original.length >= text.length) continue;
        merged[pageNumber - 1] = text;
        replaced.push(pageNumber);
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[OCR 완료] ${filename}: ${replaced.length}개 페이지 반영, ${elapsed}s`);

    return {
        pages: merged,
        fullText: merged.join(' ').trim(),
        info: {
            applied: replaced.length > 0,
            target: 'pdf',
            pages: replaced.sort((a, b) => a - b),
            failures: result.failures,
            skipped: result.skipped,
            elapsed_seconds: Number(elapsed)
        }
    };
}

/**
 * busboy (via multer) decodes multipart filenames as latin1, so a UTF-8 name such as
 * "한글 보고서.pdf" arrives mojibake'd. Reinterpreting the bytes as UTF-8 restores it;
 * ASCII names round-trip unchanged, and anything that fails to decode is left alone.
 */
function decodeFilename(name: string) {
    const reinterpreted = Buffer.from(name, 'latin1').toString('utf8');
    return reinterpreted.includes('\uFFFD') ? name : reinterpreted;
}

/**
 * Meilisearch only accepts alphanumerics, hyphens and underscores in a primary key,
 * so a Korean filename cannot be used directly. A readable ASCII slug is kept for
 * debugging and a filename hash keeps the id stable across re-uploads.
 */
function makeDocId(filename: string) {
    const slug = toAsciiSlug(filename.replace(/\.[^.]+$/, ''));
    const hash = createHash('sha256').update(filename).digest('hex').slice(0, 12);
    return slug ? `${slug}_${hash}` : `doc_${hash}`;
}

// 인덱싱 요청 형식을 복사 가능한 TypeScript 타입으로 제공
app.get('/api/index_format', (_req, res) => {
    res.type('text/plain').send(`/**
 * POST /api/index
 * Content-Type: multipart/form-data
 * 아래 필드를 FormData에 담아 전송합니다. JSON 요청은 지원하지 않습니다.
 */
export type IndexRequest = {
    /** 필수: 업로드할 파일 한 개. 최대 ${config.maxUploadBytes} bytes. */
    file: File;
    /** 영숫자, 하이픈, 언더스코어로 구성된 1~400자. 생략/공백이면 DEFAULT_INDEX 사용. */
    index?: string;
    /** OCR 모드. 기본값: 'auto'. 서버에서 OCR이 비활성화되어 있으면 적용되지 않습니다. */
    ocr?: 'auto' | 'off' | 'force';
    /** 'true'이면 동일 파일 중복 검사를 건너뜁니다. 기본값: 'false'. FormData 문자열로 전송합니다. */
    force?: 'true' | 'false';
    /** 저장할 파일 경로. 비어 있으면 path → filePath → 업로드 파일명 순으로 사용합니다. */
    filepath?: string;
    /** filepath의 별칭. */
    path?: string;
    /** filepath의 별칭. filepath와 path가 우선합니다. */
    filePath?: string;
};
`);
});

// 1. 문서 인덱싱 API (파일 업로드) — 페이지 단위로 청킹하여 적재
app.post('/api/index', upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            throw new HttpError(400, '파일이 전송되지 않았습니다.');
        }

        const indexName = resolveIndex(req.body?.index);
        const ocrMode = resolveOcrMode(req.body?.ocr);
        const filename = decodeFilename(req.file.originalname);
        const docId = makeDocId(filename);
        const fileHash = createHash('sha256').update(req.file.buffer).digest('hex');
        const filepath = req.body?.filepath || req.body?.path || req.body?.filePath || filename;
        const fileSize = req.file.buffer.length;
        console.log(`[인덱싱 요청] index=${indexName} 파일=${filename} doc_id=${docId} ocr=${ocrMode}`);

        // 동일 파일 중복 인덱싱 방지 (force 옵션이 켜져있지 않은 경우에만)
        const force = req.body?.force === 'true' || req.body?.force === true;
        if (!force) {
            const existing = await meili.findDocumentByHash(indexName, fileHash);
            if (existing) {
                console.log(`[인덱싱 건너뜀] 동일한 파일이 이미 존재합니다. 파일=${filename} hash=${fileHash}`);
                return res.json({
                    success: true,
                    status: 'skipped',
                    message: '동일한 파일이 이미 인덱싱되어 있어 처리를 건너뛰었습니다.',
                    index: indexName,
                    doc_id: existing.doc_id,
                    filename: existing.filename,
                    filepath: existing.filepath || null,
                    file_hash: existing.file_hash || null,
                    file_size: existing.file_size || null,
                    total_pages: existing.total_pages,
                    indexed_at: existing.indexed_at
                });
            }
        }

        // 1단계: 텍스트 추출 (TXT, MD 파일은 Tika를 거치지 않고 직접 처리하여 효율성 향상)
        let extracted;
        const isTxt = /\.txt$/i.test(filename);
        const isMd = /\.md$/i.test(filename);

        if (isTxt || isMd) {
            const text = req.file.buffer.toString('utf8');
            extracted = {
                pages: null,
                fullText: text,
                contentType: isMd ? 'text/markdown' : 'text/plain',
                totalPages: null,
                embeddedTexts: []
            };
        } else {
            extracted = await tika.extract(req.file.buffer, filename);
        }

        // 2단계: 텍스트가 없는 페이지는 Ollama 비전 모델로 OCR 보완
        const ocrResult = await applyOcr({
            buffer: req.file.buffer,
            filename,
            extracted,
            mode: ocrMode
        });
        const ocrPages = new Set(ocrResult.info?.pages ?? []);

        // 3단계: 페이지 기준 청킹 (작은 페이지는 병합, 큰 페이지는 겹침 분할)
        const chunks = buildChunks(
            { ...extracted, pages: ocrResult.pages, fullText: ocrResult.fullText },
            config.chunk
        );
        if (chunks.length === 0) {
            throw new HttpError(
                422,
                config.ocr.enabled && ocrMode !== 'off'
                    ? '텍스트를 추출하지 못했습니다. OCR 도 결과를 내지 못했습니다.'
                    : '추출된 텍스트가 없습니다. 빈 파일이 아닌지 확인하거나, 스캔 이미지 PDF라면 ocr=auto 로 다시 시도해 보세요.'
            );
        }

        const totalPages = extracted.totalPages ?? ocrResult.pages?.length ?? null;
        const indexedAt = new Date().toISOString();
        const documents = chunks.map((chunk) => ({
            id: `${docId}_${chunk.suffix}`,
            doc_id: docId,
            filename,
            filepath,
            file_hash: fileHash,
            file_size: fileSize,
            page: chunk.page,
            page_end: chunk.pageEnd,
            total_pages: totalPages,
            // True when any page covered by this chunk was recovered via OCR, so callers
            // can treat the text as lower confidence.
            ocr: chunk.page === null
                ? ocrResult.info?.target === 'image'
                : rangeIncludesOcr(chunk.page, chunk.pageEnd, ocrPages),
            content: chunk.text,
            indexed_at: indexedAt
        }));

        // 3단계: 인덱스 준비 → 이전 청크 제거 → 새 청크 적재
        await meili.ensureIndex(indexName);
        await meili.deleteDocumentChunks(indexName, docId, filename);
        const taskUids = await meili.addDocuments(indexName, documents);

        const summary = {
            index: indexName,
            doc_id: docId,
            filename,
            filepath,
            file_hash: fileHash,
            file_size: fileSize,
            content_type: extracted.contentType,
            paged: Boolean(ocrResult.pages?.length),
            ocr: ocrResult.info,
            total_pages: totalPages,
            chunks: documents.length,
            embedded_parts: extracted.embeddedTexts.length,
            tasks: taskUids
        };

        try {
            await Promise.all(taskUids.map((uid) => meili.waitForTask(uid)));
        } catch (error) {
            // Large documents can outlast the wait window. The tasks are still queued,
            // so report them instead of failing a request that will likely succeed.
            console.warn(`[인덱싱 대기 중단] ${errorMessage(error)}`);
            return res.status(202).json({ success: true, status: 'pending', ...summary });
        }

        console.log(`[인덱싱 완료] ${documents.length}개 청크 (페이지 ${totalPages ?? '미확인'})\n`);
        res.json({ success: true, status: 'succeeded', ...summary });
    } catch (error) {
        next(error);
    }
});

// 2. 통합 검색 API — 페이지 정보를 함께 반환
app.post('/api/search', async (req, res, next) => {
    try {
        const { q, limit = 10, offset = 0, filter, groupByDoc = false } = req.body ?? {};
        if (!q) {
            throw new HttpError(400, '검색어(q)가 필요합니다.');
        }

        const indexName = resolveIndex(req.body?.index);
        const body: Record<string, unknown> = {
            q,
            limit,
            offset,
            attributesToRetrieve: ['id', 'doc_id', 'filename', 'filepath', 'file_hash', 'file_size', 'page', 'page_end', 'total_pages', 'ocr'],
            attributesToHighlight: ['content'],
            attributesToCrop: ['content'],
            cropLength: 40
        };

        if (filter) body.filter = filter;
        // Collapse to one hit per document so a single PDF cannot flood the results.
        if (groupByDoc) body.distinct = 'doc_id';

        res.json(await meili.search(indexName, body));
    } catch (error) {
        next(error);
    }
});

// 3. 인덱스 정보 — 기본값은 DEFAULT_INDEX
app.get('/api/index/info', async (req, res, next) => {
    try {
        const indexName = resolveIndex(req.query?.index);
        const limit = Number(req.query?.limit ?? 100);
        if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
            throw new HttpError(400, 'limit 은 0 이상 1000 이하의 정수여야 합니다.');
        }

        if (!(await meili.indexExists(indexName))) {
            return res.json({
                index: indexName,
                exists: false,
                is_default: indexName === config.defaultIndex,
                chunks: 0,
                document_count: 0,
                documents: []
            });
        }

        const [stats, settings, summary] = await Promise.all([
            meili.getStats(indexName),
            meili.getSettings(indexName),
            meili.summariseDocuments(indexName, limit)
        ]);

        res.json({
            index: indexName,
            exists: true,
            is_default: indexName === config.defaultIndex,
            // Meilisearch counts chunks, since one chunk is one Meilisearch document.
            chunks: stats.numberOfDocuments,
            is_indexing: stats.isIndexing,
            document_count: summary.documentCount,
            documents: summary.documents,
            field_distribution: stats.fieldDistribution,
            settings: {
                searchable: settings.searchableAttributes,
                filterable: settings.filterableAttributes,
                sortable: settings.sortableAttributes
            }
        });
    } catch (error) {
        next(error);
    }
});

// 4. 인덱스 리셋 — 파괴적이므로 confirm 에 인덱스 이름을 그대로 넣어야 실행된다
app.post('/api/index/reset', async (req, res, next) => {
    try {
        const indexName = resolveIndex(req.body?.index);
        const confirm = String(req.body?.confirm ?? '');
        if (confirm !== indexName) {
            throw new HttpError(
                400,
                `실수 방지를 위해 confirm 에 인덱스 이름을 그대로 넣어야 합니다. 기대값: "${indexName}"`
            );
        }

        const mode = req.body?.mode === 'drop' ? 'drop' : 'clear';
        if (!(await meili.indexExists(indexName))) {
            return res.status(404).json({
                success: false,
                error: `인덱스 "${indexName}" 가 존재하지 않습니다.`
            });
        }

        const before = await meili.getStats(indexName);
        if (mode === 'drop') {
            await meili.dropIndex(indexName);
        } else {
            await meili.clearDocuments(indexName);
        }

        console.log(`[인덱스 리셋] ${indexName} mode=${mode} 삭제된 청크=${before.numberOfDocuments}`);
        res.json({
            success: true,
            index: indexName,
            mode,
            deleted_chunks: before.numberOfDocuments
        });
    } catch (error) {
        next(error);
    }
});

// 5. 인덱싱 작업 상태 조회 (202 응답을 받은 경우 확인용)
app.get('/api/task/:uid', async (req, res, next) => {
    try {
        if (!/^\d+$/.test(req.params.uid)) {
            throw new HttpError(400, 'task uid 는 숫자여야 합니다.');
        }
        res.json(await meili.request(`/tasks/${req.params.uid}`));
    } catch (error) {
        next(error);
    }
});

// 6. CLI 인덱싱 스크립트 다운로드 API — 동적으로 요청의 Host 를 반영하여 index.sh 파일 다운로드 지원
app.get('/api/script', (req, res) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers.host || `localhost:${config.port}`;
    const scriptContent = `#!/usr/bin/env bash
set -euo pipefail

# Usage: index.sh <file_path> [index_name] [ocr_mode]
# Examples:
#   ./index.sh /path/to/document.pdf
#   ./index.sh /path/to/document.md
#   ./index.sh /path/to/document.txt
#   ./index.sh /path/to/document.pdf my_docs auto

if [ \$# -lt 1 ]; then
  echo "사용법: \$0 <파일_경로> [인덱스_이름] [OCR_모드]"
  echo "예시:  \$0 /home/user/document.pdf my_docs auto"
  echo "예시:  \$0 /home/user/document.md"
  echo "예시:  \$0 /home/user/document.txt"
  exit 1
fi

FILEPATH="\$1"
INDEX="\${2:-}"
OCR="\${3:-auto}"

if [ ! -f "\$FILEPATH" ]; then
  echo "Error: 파일을 찾을 수 없습니다: \$FILEPATH"
  exit 1
fi

# Resolve absolute path
ABS_PATH=\$\(realpath "\$FILEPATH"\)
FILENAME=\$\(basename "\$FILEPATH"\)

HOST="${host}"
URL="${proto}://\${HOST}/api/index"

echo "========================================"
echo "📄 파일 인덱싱 요청 시작"
echo "파일 경로:  \$ABS_PATH"
echo "인덱스명:   \${INDEX:-기본 인덱스}"
echo "OCR 모드:   \$OCR"
echo "서버 주소:  \$URL"
echo "========================================"

# Prepare curl arguments
ARGS=\(
  -fsSL
  -F "file=@\${ABS_PATH}"
  -F "filepath=\${ABS_PATH}"
\)

if [ -n "\$INDEX" ]; then
  ARGS+=\(-F "index=\${INDEX}"\)
fi

if [ -n "\$OCR" ]; then
  ARGS+=\(-F "ocr=\${OCR}"\)
fi

RESPONSE=\$\(curl "\${ARGS[@]}" "\$URL"\)

# Check if jq is available to format JSON beautifully and preserve Korean UTF-8 characters
if command -v jq &>/dev/null; then
  echo "\$RESPONSE" | jq .
elif command -v python3 &>/dev/null; then
  echo "\$RESPONSE" | python3 -m json.tool
else
  echo "\$RESPONSE"
fi
`;
    res.setHeader('Content-Type', 'text/x-sh');
    res.setHeader('Content-Disposition', 'attachment; filename="index.sh"');
    res.send(scriptContent);
});

app.get('/health', (_req, res) => {
    res.json({ ok: true, default_index: config.defaultIndex });
});

// 오류 응답 일원화 (업로드 용량 초과 포함)
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            success: false,
            error: `업로드 용량 한도(${Math.round(config.maxUploadBytes / 1024 / 1024)}MB)를 초과했습니다.`
        });
    }

    const status = error.status ?? 500;
    if (status >= 500) {
        console.error('❌ 오류 발생:', errorMessage(error));
    }
    res.status(status).json({ success: false, error: errorMessage(error) });
};
app.use(errorHandler);

app.listen(config.port, () => {
    console.log(`🚀 백엔드 서버가 http://localhost:${config.port} 에서 실행 중입니다.`);
    console.log(`   Meilisearch: ${config.meiliUrl} / Tika: ${config.tikaUrl}`);
    console.log(`   기본 인덱스: ${config.defaultIndex}`);
});
