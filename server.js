import { createHash } from 'node:crypto';
import express from 'express';
import multer from 'multer';

import { config, SAFE_ID } from './config.js';
import * as tika from './lib/tika.js';
import * as meili from './lib/meili.js';
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
        const filename = decodeFilename(req.file.originalname);
        const docId = makeDocId(filename);
        console.log(`[인덱싱 요청] index=${indexName} 파일=${filename} doc_id=${docId}`);

        // 1단계: Tika 로 텍스트와 페이지 구조 추출
        const extracted = await tika.extract(req.file.buffer, filename);

        // 2단계: 페이지 기준 청킹 (작은 페이지는 병합, 큰 페이지는 겹침 분할)
        const chunks = buildChunks(extracted, config.chunk);
        if (chunks.length === 0) {
            throw new HttpError(422, '추출된 텍스트가 없습니다. 스캔 이미지 PDF라면 OCR 설정이 필요합니다.');
        }

        const totalPages = extracted.totalPages ?? extracted.pages?.length ?? null;
        const indexedAt = new Date().toISOString();
        const documents = chunks.map((chunk) => ({
            id: `${docId}_${chunk.suffix}`,
            doc_id: docId,
            filename,
            page: chunk.page,
            page_end: chunk.pageEnd,
            total_pages: totalPages,
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
            paged: Boolean(extracted.pages?.length),
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
            attributesToRetrieve: ['id', 'doc_id', 'filename', 'page', 'page_end', 'total_pages'],
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
