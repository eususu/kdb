import { errorMessage } from './types.ts';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { PNG } from 'pngjs';

import { config } from '../config.ts';

const PROMPT = [
  'Transcribe all text visible in this image, exactly as written.',
  'Preserve the reading order and line breaks.',
  'Do not translate, summarise, describe, or comment.',
  'Output only the transcribed text. If there is no text, output nothing.'
].join(' ');

/**
 * PDFium returns BGRA pixels; PNG expects RGBA. Swapping the red and blue channels
 * is enough to convert between them.
 */
function bgraToPng(width: number, height: number, bgra: Uint8Array) {
  const png = new PNG({ width, height });
  for (let i = 0; i < bgra.length; i += 4) {
    png.data[i] = bgra[i + 2];
    png.data[i + 1] = bgra[i + 1];
    png.data[i + 2] = bgra[i];
    png.data[i + 3] = bgra[i + 3];
  }
  return PNG.sync.write(png);
}

/**
 * Renders the requested 1-based pages of a PDF to PNG buffers.
 * A fresh library instance per call keeps concurrent requests from sharing WASM state.
 */
export async function renderPdfPages(pdfBuffer: Buffer, pageNumbers: number[]) {
  const library = await PDFiumLibrary.init();
  const images = new Map<number, Buffer>();

  try {
    const document = await library.loadDocument(pdfBuffer);
    try {
      const pageCount = document.getPageCount();
      for (const pageNumber of pageNumbers) {
        if (pageNumber < 1 || pageNumber > pageCount) continue;
        const page = document.getPage(pageNumber - 1);
        const rendered = await page.render({ scale: config.ocr.scale, render: 'bitmap' });
        images.set(pageNumber, bgraToPng(rendered.width, rendered.height, rendered.data));
      }
    } finally {
      document.destroy();
    }
  } finally {
    library.destroy();
  }

  return images;
}

/** Number of pages in a PDF, or null when the buffer is not a readable PDF. */
export async function getPdfPageCount(pdfBuffer: Buffer) {
  let library;
  try {
    library = await PDFiumLibrary.init();
    const document = await library.loadDocument(pdfBuffer);
    try {
      return document.getPageCount();
    } finally {
      document.destroy();
    }
  } catch {
    return null;
  } finally {
    library?.destroy();
  }
}

/** Sends one image to the Ollama vision model and returns the transcribed text. */
export async function transcribeImage(imageBuffer: Buffer): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ocr.timeoutMs);

  try {
    const response = await fetch(`${config.ocr.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ocr.model,
        prompt: PROMPT,
        images: [imageBuffer.toString('base64')],
        stream: false,
        // These models default to a reasoning pass, which slows OCR down and can leak
        // commentary into the output.
        think: false,
        options: { temperature: 0 }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Ollama 응답 오류 (HTTP ${response.status})`);
    }

    const data = await response.json();
    if (data.error) throw new Error(`Ollama 오류: ${data.error}`);
    return (data.response ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `worker` over `items` with a bounded number of parallel calls. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * OCRs the given 1-based PDF pages.
 * @returns {Promise<{texts: Map<number, string>, failures: Array<{page: number, error: string}>}>}
 */
export async function ocrPdfPages(pdfBuffer: Buffer, pageNumbers: number[]) {
  const capped = pageNumbers.slice(0, config.ocr.maxPages);
  const images = await renderPdfPages(pdfBuffer, capped);

  const texts = new Map<number, string>();
  const failures: { page: number; error: string }[] = [];

  await mapLimit([...images.keys()], config.ocr.concurrency, async (pageNumber) => {
    try {
      const text = await transcribeImage(images.get(pageNumber)!);
      if (text) texts.set(pageNumber, text);
    } catch (error) {
      // One unreadable page should not sink the whole upload.
      const reason = error instanceof Error && error.name === 'AbortError' ? `${config.ocr.timeoutMs}ms 초과` : errorMessage(error);
      failures.push({ page: pageNumber, error: reason });
    }
  });

  return { texts, failures, skipped: Math.max(0, pageNumbers.length - capped.length) };
}
