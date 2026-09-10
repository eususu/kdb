import test from 'node:test';
import assert from 'node:assert';
import { config } from '../config.ts';

test('Native TXT/MD Parsing Integration Test', async (t) => {
    const url = 'http://localhost:' + config.port + '/api/index';

    await t.test('Successfully indexes a plain text file natively', async () => {
        const formData = new FormData();
        const content = '이것은 내장 테스트 파일의 내용입니다. 자바스크립트로 직접 파싱하여 Meilisearch로 전달합니다.';
        const blob = new Blob([content], { type: 'text/plain' });
        formData.append('file', blob, 'native-test.txt');
        formData.append('index', 'test_index_suite');
        formData.append('force', 'true');

        const response = await fetch(url, {
            method: 'POST',
            body: formData,
        });

        assert.strictEqual(response.status, 200);
        const data = await response.json();
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.status, 'succeeded');
        assert.strictEqual(data.filename, 'native-test.txt');
        assert.strictEqual(data.content_type, 'text/plain');
        assert.strictEqual(data.paged, false);
        assert.strictEqual(data.chunks, 1);
    });

    await t.test('Successfully indexes a markdown file natively', async () => {
        const formData = new FormData();
        const content = '# 네이티브 마크다운 테스트\n\n이것은 마크다운 파일의 내용입니다.';
        const blob = new Blob([content], { type: 'text/markdown' });
        formData.append('file', blob, 'native-test.md');
        formData.append('index', 'test_index_suite');
        formData.append('force', 'true');

        const response = await fetch(url, {
            method: 'POST',
            body: formData,
        });

        assert.strictEqual(response.status, 200);
        const data = await response.json();
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.status, 'succeeded');
        assert.strictEqual(data.filename, 'native-test.md');
        assert.strictEqual(data.content_type, 'text/markdown');
        assert.strictEqual(data.paged, false);
        assert.strictEqual(data.chunks, 1);
    });

    await t.test('Successfully searches for the indexed content', async () => {
        const searchUrl = 'http://localhost:' + config.port + '/api/search';
        const payload = {
            index: 'test_index_suite',
            q: '자바스크립트'
        };

        const response = await fetch(searchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(response.status, 200);
        const data = await response.json();
        assert.ok(data.hits.length > 0);
        assert.strictEqual(data.hits[0].filename, 'native-test.txt');
    });
});

test('GET /api/index_format returns the multipart TypeScript contract', async () => {
    const response = await fetch(`http://localhost:${config.port}/api/index_format`);
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain; charset=utf-8$/);
    const body = await response.text();
    assert.match(body, /export type IndexRequest = \{/);
    assert.match(body, /file: File;/);
    for (const field of ['index', 'ocr', 'force', 'filepath', 'path', 'filePath']) {
        assert.ok(body.includes(`${field}?:`));
    }
    assert.match(body, /multipart\/form-data/);
});
