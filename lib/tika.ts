import type { ExtractedDocument } from './types.ts';
import { config } from '../config.ts';

/**
 * Tika 4.x only serves plain text from PUT /tika, so page boundaries have to come
 * from the XHTML that PUT /rmeta/html returns. For PDFs the PDFParser wraps every
 * page in `<div class="page">`, which is what we split on.
 */
const PAGE_MARKER = /<div\s+class="(?:page|slide-content)"[^>]*>/gi;

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'"
};

/** Strips XHTML markup and decodes entities into a single normalised line of text. */
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|lt|gt|quot|apos|#39);/gi, (_, name) => ENTITIES[name.toLowerCase()] ?? ' ')
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    // `&amp;` is decoded last so `&amp;lt;` does not turn into a tag-like sequence.
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(code: number) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/**
 * Splits Tika XHTML into per-page text.
 * Returns null when the format carries no page markers (DOCX, HTML, plain text, ...),
 * so the caller can fall back to size-based chunking.
 */
export function splitPages(xhtml: string) {
  const body = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? xhtml;
  const starts = [...body.matchAll(PAGE_MARKER)].map((m) => m.index);
  if (starts.length === 0) return null;

  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : body.length;
    return htmlToText(body.slice(start, end));
  });
}

/** HTTP headers reject non-ASCII, so the filename hint sent to Tika is stripped down. */
function asciiFilename(filename: string) {
  const cleaned = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\\r\n]/g, '_');
  return cleaned || 'upload';
}

/**
 * Sends the buffer to Tika and returns page text plus the metadata we care about.
 * `pages` is null when the document has no page structure.
 */
export async function extract(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
  const response = await fetch(`${config.tikaUrl}/rmeta/html`, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Disposition': `attachment; filename="${asciiFilename(filename)}"`
    },
    body: new Uint8Array(buffer)
  });

  if (!response.ok) {
    throw new Error(`Tika 추출 실패 (HTTP ${response.status} ${response.statusText})`);
  }

  const entries = await response.json();
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Tika 응답이 비어 있습니다.');
  }

  const [main, ...embedded] = entries;
  const content = main['tk:content'] ?? '';

  return {
    pages: splitPages(content),
    fullText: htmlToText(content),
    contentType: main['Content-Type'] ?? null,
    totalPages: toInt(main['xmpTPg:NPages']),
    // Attachments inside the document (PDF in PDF, embedded spreadsheets, ...).
    // They have no page numbers of their own, so they are chunked by size.
    embeddedTexts: embedded
      .map((entry) => htmlToText(entry['tk:content'] ?? ''))
      .filter((text) => text.length > 0)
  };
}

function toInt(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}
