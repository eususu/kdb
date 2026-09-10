import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunks } from '../lib/chunk.ts';
import { htmlToText, splitPages } from '../lib/tika.ts';
import { toAsciiSlug } from '../lib/slug.ts';

test('merges short trailing pages while retaining page ranges', () => {
  assert.deepEqual(buildChunks({ pages: ['first page', 'end'], fullText: '' }, {
    minChars: 8, maxChars: 100, overlapChars: 0
  }), [{ suffix: 'p1c0', page: 1, pageEnd: 2, text: 'first page end' }]);
});

test('splits long text with overlap and preserves embedded text', () => {
  assert.deepEqual(buildChunks({ pages: null, fullText: 'abcdefghij', embeddedTexts: ['attachment'] }, {
    minChars: 1, maxChars: 6, overlapChars: 2
  }).map(chunk => chunk.text), ['abcdef', 'efghij', 'attach', 'chment']);
});

test('extracts XHTML pages and decodes entities without retaining scripts', () => {
  assert.deepEqual(splitPages('<body><div class="page">A &amp; B</div><div class="page">&#54620;글</div></body>'), ['A & B', '한글']);
  assert.equal(htmlToText('<script>hidden</script>&amp;lt; &lt; &#x110000;'), '&lt; <');
  assert.equal(splitPages('<p>unpaged</p>'), null);
});

test('normalizes filename slugs and handles non-Latin names', () => {
  assert.equal(toAsciiSlug('Résumé Report'), 'resume-report');
  assert.equal(toAsciiSlug('한글 보고서'), '');
});
