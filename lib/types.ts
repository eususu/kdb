export interface ExtractedDocument {
  pages: string[] | null;
  fullText: string;
  contentType: string | null;
  totalPages: number | null;
  embeddedTexts: string[];
}

export interface Chunk {
  suffix: string;
  page: number | null;
  pageEnd: number | null;
  text: string;
}

export interface IndexedDocument {
  id: string;
  doc_id: string;
  filename: string;
  filepath: string;
  file_hash: string;
  file_size: number;
  page: number | null;
  page_end: number | null;
  total_pages: number | null;
  ocr: boolean | undefined;
  content: string;
  indexed_at: string;
}

export interface OcrInfo {
  applied: boolean;
  target: 'image' | 'pdf';
  pages?: number[];
  failures?: { page: number; error: string }[];
  skipped?: number;
  error?: string;
  elapsed_seconds?: number;
}

export interface OcrResult {
  pages: string[] | null;
  fullText: string;
  info: OcrInfo | null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
