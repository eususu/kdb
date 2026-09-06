/**
 * Turns extracted text into Meilisearch-sized chunks.
 *
 * Pages are the primary unit because they map to something a reader can act on
 * ("see page 12"). Raw pages are unusable on their own though: cover pages hold a
 * dozen characters while a dense page can hold thousands. So tiny pages are merged
 * forward and oversized pages are split into overlapping windows.
 */

/** Merges pages shorter than `minChars` into the following page. */
function groupPages(pages, minChars) {
  const groups = [];
  let buffer = null;

  pages.forEach((text, index) => {
    const pageNumber = index + 1;
    if (buffer === null) {
      buffer = { page: pageNumber, pageEnd: pageNumber, text };
    } else {
      buffer.text = buffer.text ? `${buffer.text} ${text}` : text;
      buffer.pageEnd = pageNumber;
    }
    if (buffer.text.length >= minChars) {
      groups.push(buffer);
      buffer = null;
    }
  });

  // Trailing remainder is too small to stand alone: fold it into the previous group.
  if (buffer !== null) {
    const last = groups.at(-1);
    if (last) {
      last.text = `${last.text} ${buffer.text}`.trim();
      last.pageEnd = buffer.pageEnd;
    } else {
      groups.push(buffer);
    }
  }

  return groups;
}

/** Splits text into <= maxChars windows, preferring word boundaries and keeping an overlap. */
function splitText(text, maxChars, overlap) {
  if (text.length <= maxChars) {
    // Merged groups can join whitespace-only pages, so trim before deciding it has content.
    const single = text.trim();
    return single ? [single] : [];
  }

  const parts = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      // Only honour the boundary if it keeps the window reasonably full. Scripts
      // without spaces (Korean, Chinese, Japanese) fall back to a hard cut.
      if (space > start + Math.floor(maxChars / 2)) end = space;
    }

    const piece = text.slice(start, end).trim();
    if (piece) parts.push(piece);
    if (end >= text.length) break;

    const next = end - overlap;
    // Never move backwards, otherwise the loop would not terminate.
    start = next > start ? next : end;
  }

  return parts;
}

/**
 * @returns {Array<{suffix: string, page: number|null, pageEnd: number|null, text: string}>}
 */
export function buildChunks(extracted, { minChars, maxChars, overlapChars }) {
  const { pages, fullText, embeddedTexts = [] } = extracted;
  const chunks = [];

  if (pages && pages.length > 0) {
    for (const group of groupPages(pages, minChars)) {
      splitText(group.text, maxChars, overlapChars).forEach((text, i) => {
        chunks.push({
          suffix: `p${group.page}c${i}`,
          page: group.page,
          pageEnd: group.pageEnd,
          text
        });
      });
    }
  } else if (fullText) {
    // No page markers in this format, so chunk purely by size.
    splitText(fullText, maxChars, overlapChars).forEach((text, i) => {
      chunks.push({ suffix: `c${i}`, page: null, pageEnd: null, text });
    });
  }

  embeddedTexts.forEach((text, entryIndex) => {
    splitText(text, maxChars, overlapChars).forEach((piece, i) => {
      chunks.push({
        suffix: `e${entryIndex}c${i}`,
        page: null,
        pageEnd: null,
        text: piece
      });
    });
  });

  return chunks.filter((chunk) => chunk.text.length > 0);
}
