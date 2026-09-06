import { createHash } from 'node:crypto';
import express from 'express';
import multer from 'multer';

import { config, SAFE_ID } from './config.js';
import * as tika from './lib/tika.js';
import * as meili from './lib/meili.js';
import * as ocr from './lib/ocr.js';
import { buildChunks } from './lib/chunk.js';

const app = express();
app.use(express.json());

// 파일을 메모리에 일시 저장하여 스트림으로 다루기 위한 설정
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes }
});

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** Index name comes from the request, falling back to DEFAULT_INDEX. */
function resolveIndex(value) {
    const name = String(value ?? '').trim() || config.defaultIndex;
    if (!SAFE_ID.test(name)) {
        throw new HttpError(400, `index 이름은 영숫자, 하이픈, 언더스코어만 쓸 수 있습니다. 받은 값: ${name}`);
    }
    return name;
}

/** A merged chunk can span several pages, so any OCR'd page in the range taints it. */
function rangeIncludesOcr(pageStart, pageEnd, ocrPages) {
    if (ocrPages.size === 0) return false;
    for (let page = pageStart; page <= pageEnd; page += 1) {
        if (ocrPages.has(page)) return true;
    }
    return false;
}

const OCR_MODES = new Set(['auto', 'off', 'force']);

function resolveOcrMode(value) {
    const mode = String(value ?? 'auto').trim().toLowerCase() || 'auto';
    if (!OCR_MODES.has(mode)) {
        throw new HttpError(400, `ocr 는 ${[...OCR_MODES].join(', ')} 중 하나여야 합니다. 받은 값: ${mode}`);
    }
    return mode;
}

function isPdf(contentType, filename) {
    return /pdf/i.test(contentType ?? '') || /\.pdf$/i.test(filename);
}

/**
 * Fills in text for pages Tika could not read, by rendering them and running the
 * Ollama vision model over the images.
 *
 * @returns {Promise<{pages: string[]|null, fullText: string, info: object|null}>}
 */
async function applyOcr({ buffer, filename, extracted, mode }) {
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
            console.warn(`[OCR 실패] ${filename}: ${error.message}`);
            return { ...skip, info: { applied: false, target: 'image', error: error.message } };
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
        console.warn(`[OCR 실패] ${filename}: ${error.message}`);
        return { ...skip, info: { applied: false, target: 'pdf', error: error.message } };
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
function decodeFilename(name) {
    const reinterpreted = Buffer.from(name, 'latin1').toString('utf8');
    return reinterpreted.includes('\uFFFD') ? name : reinterpreted;
}

/**
 * Meilisearch only accepts alphanumerics, hyphens and underscores in a primary key,
 * so a Korean filename cannot be used directly. A readable ASCII slug is kept for
 * debugging and a filename hash keeps the id stable across re-uploads.
 */
function makeDocId(filename) {
    const slug = filename
        .normalize('NFC')
        .replace(/\.[^.]+$/, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    const hash = createHash('sha256').update(filename).digest('hex').slice(0, 12);
    return slug ? `${slug}_${hash}` : `doc_${hash}`;
}

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
        console.log(`[인덱싱 요청] index=${indexName} 파일=${filename} doc_id=${docId} ocr=${ocrMode}`);

        // 1단계: Tika 로 텍스트와 페이지 구조 추출
        const extracted = await tika.extract(req.file.buffer, filename);

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
                    : '추출된 텍스트가 없습니다. 스캔 이미지 PDF라면 ocr=auto 로 다시 시도해 보세요.'
            );
        }

        const totalPages = extracted.totalPages ?? ocrResult.pages?.length ?? null;
        const indexedAt = new Date().toISOString();
        const documents = chunks.map((chunk) => ({
            id: `${docId}_${chunk.suffix}`,
            doc_id: docId,
            filename,
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
        await meili.deleteDocumentChunks(indexName, docId);
        const taskUids = await meili.addDocuments(indexName, documents);

        const summary = {
            index: indexName,
            doc_id: docId,
            filename,
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
            console.warn(`[인덱싱 대기 중단] ${error.message}`);
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
        const body = {
            q,
            limit,
            offset,
            attributesToRetrieve: ['id', 'doc_id', 'filename', 'page', 'page_end', 'total_pages', 'ocr'],
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

// 3. 인덱싱 작업 상태 조회 (202 응답을 받은 경우 확인용)
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

app.get('/health', (_req, res) => {
    res.json({ ok: true, default_index: config.defaultIndex });
});

// 오류 응답 일원화 (업로드 용량 초과 포함)
app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            success: false,
            error: `업로드 용량 한도(${Math.round(config.maxUploadBytes / 1024 / 1024)}MB)를 초과했습니다.`
        });
    }

    const status = error.status ?? 500;
    if (status >= 500) {
        console.error('❌ 오류 발생:', error.message);
    }
    res.status(status).json({ success: false, error: error.message });
});

app.listen(config.port, () => {
    console.log(`🚀 백엔드 서버가 http://localhost:${config.port} 에서 실행 중입니다.`);
    console.log(`   Meilisearch: ${config.meiliUrl} / Tika: ${config.tikaUrl}`);
    console.log(`   기본 인덱스: ${config.defaultIndex}`);
});
