import type { IndexedDocument } from './types.ts';
import { errorMessage } from './types.ts';

interface Task {
  taskUid: number;
  status: string;
  error?: { message?: string };
}
interface SearchResult {
  hits: IndexedDocument[];
  facetDistribution?: Record<string, Record<string, number>>;
}
interface IndexStats {
  numberOfDocuments: number;
  isIndexing: boolean;
  fieldDistribution: Record<string, number>;
}
interface IndexSettings {
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
}
class MeiliError extends Error {
  meiliCode?: string;
  status?: number;
}

import { config } from '../config.ts';

const INDEX_SETTINGS = {
  searchableAttributes: ['filename', 'content'],
  // doc_id must be filterable so re-indexing can delete a document's old chunks,
  // and so search can collapse results per document via `distinct`.
  filterableAttributes: ['doc_id', 'filename', 'filepath', 'file_hash', 'page', 'ocr'],
  sortableAttributes: ['page', 'indexed_at'],
  // The info endpoint counts chunks per document with a doc_id facet, and the default
  // cap of 100 facet values would silently truncate that list.
  faceting: { maxValuesPerFacet: 1000 }
};

/** Indexes whose settings have already been applied during this process lifetime. */
const preparedIndexes = new Set<string>();

export async function request<T = Task>(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${config.meiliUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.meiliKey}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Meilisearch 응답을 해석할 수 없습니다 (${method} ${path}): ${raw.slice(0, 200)}`);
    }
  }

  if (!response.ok) {
    const detail = data?.message ?? raw.slice(0, 200);
    const error = new MeiliError(`Meilisearch ${method} ${path} → HTTP ${response.status}: ${detail}`);
    error.meiliCode = data?.code;
    error.status = response.status;
    throw error;
  }

  return data as T;
}

/**
 * Meilisearch applies writes asynchronously. Waiting matters here because a failed
 * task otherwise looks like success to the caller.
 */
export async function waitForTask(taskUid: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 50;

  while (Date.now() < deadline) {
    const task = await request(`/tasks/${taskUid}`);
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed' || task.status === 'canceled') {
      throw new Error(`Meilisearch 작업 ${taskUid} ${task.status}: ${task.error?.message ?? '원인 불명'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 500);
  }

  throw new Error(`Meilisearch 작업 ${taskUid} 가 ${timeoutMs}ms 안에 끝나지 않았습니다.`);
}

/** Creates the index if needed and applies our settings. Cached after the first call. */
export async function ensureIndex(uid: string) {
  if (preparedIndexes.has(uid)) return;

  if (!(await indexExists(uid))) {
    try {
      const created = await request('/indexes', {
        method: 'POST',
        body: { uid, primaryKey: 'id' }
      });
      await waitForTask(created.taskUid);
    } catch (error) {
      // Creating an existing index is reported two different ways: as an HTTP error,
      // or as an accepted task that later fails. Another request racing us to create
      // the same index lands here too, and is equally harmless.
      const alreadyExists =
        (error instanceof MeiliError && error.meiliCode === 'index_already_exists') || /already exists/i.test(errorMessage(error));
      if (!alreadyExists) throw error;
    }
  }

  const updated = await request(`/indexes/${uid}/settings`, {
    method: 'PATCH',
    body: INDEX_SETTINGS
  });
  await waitForTask(updated.taskUid);

  preparedIndexes.add(uid);
}

/** Escapes a value for use inside a double-quoted Meilisearch filter literal. */
function quoteFilterValue(value: string) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Removes every chunk belonging to a document. Without this, re-indexing a file that
 * shrank from 20 to 15 pages would leave pages 16-20 behind as orphans.
 *
 * Matching on filename as well as doc_id matters whenever the id scheme changes: the
 * same file would otherwise produce a new doc_id and strand all of its previous chunks.
 */
export async function deleteDocumentChunks(uid: string, docId: string, filename?: string) {
  const clauses = [`doc_id = ${quoteFilterValue(docId)}`];
  if (filename) clauses.push(`filename = ${quoteFilterValue(filename)}`);

  const task = await request(`/indexes/${uid}/documents/delete`, {
    method: 'POST',
    body: { filter: clauses.join(' OR ') }
  });
  return waitForTask(task.taskUid);
}

/** Adds documents in batches so a large PDF does not become one huge request body. */
export async function addDocuments(uid: string, documents: IndexedDocument[], batchSize = 200) {
  const tasks: number[] = [];

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    const task = await request(`/indexes/${uid}/documents`, {
      method: 'POST',
      body: batch
    });
    tasks.push(task.taskUid);
  }

  return tasks;
}

export async function search(uid: string, body: Record<string, unknown>) {
  return request<SearchResult>(`/indexes/${uid}/search`, { method: 'POST', body });
}

export async function indexExists(uid: string) {
  try {
    await request(`/indexes/${uid}`);
    return true;
  } catch (error) {
    if (error instanceof MeiliError && error.status === 404) return false;
    throw error;
  }
}

export async function getStats(uid: string) {
  return request<IndexStats>(`/indexes/${uid}/stats`);
}

export async function getSettings(uid: string) {
  return request<IndexSettings>(`/indexes/${uid}/settings`);
}

/**
 * One entry per indexed document (not per chunk), newest first.
 * Chunk counts come from a doc_id facet because Meilisearch has no group-by.
 */
/**
 * Finds a document chunk in the index by its file content hash.
 * Returns the first hit or null.
 */
export async function findDocumentByHash(uid: string, fileHash: string) {
  if (!(await indexExists(uid))) return null;
  const response = await search(uid, {
    filter: `file_hash = ${quoteFilterValue(fileHash)}`,
    limit: 1,
    attributesToRetrieve: ['doc_id', 'filename', 'filepath', 'file_hash', 'file_size', 'total_pages', 'indexed_at']
  });
  return response.hits?.[0] ?? null;
}

export async function summariseDocuments(uid: string, limit = 100) {
  const [faceted, listed] = await Promise.all([
    search(uid, { q: '', limit: 0, facets: ['doc_id'] }),
    search(uid, {
      q: '',
      limit,
      distinct: 'doc_id',
      attributesToRetrieve: ['doc_id', 'filename', 'filepath', 'file_hash', 'file_size', 'total_pages', 'ocr', 'indexed_at'],
      sort: ['indexed_at:desc']
    })
  ]);

  const chunkCounts = faceted.facetDistribution?.doc_id ?? {};

  return {
    documentCount: Object.keys(chunkCounts).length,
    documents: (listed.hits ?? []).map((hit) => ({
      doc_id: hit.doc_id,
      filename: hit.filename,
      filepath: hit.filepath ?? null,
      file_hash: hit.file_hash ?? null,
      file_size: hit.file_size ?? null,
      total_pages: hit.total_pages,
      chunks: chunkCounts[hit.doc_id] ?? null,
      ocr: hit.ocr,
      indexed_at: hit.indexed_at
    }))
  };
}

/** Empties an index but keeps it and its settings in place. */
export async function clearDocuments(uid: string) {
  const task = await request(`/indexes/${uid}/documents`, { method: 'DELETE' });
  return waitForTask(task.taskUid);
}

/** Drops the index entirely, settings included. */
export async function dropIndex(uid: string) {
  const task = await request(`/indexes/${uid}`, { method: 'DELETE' });
  const result = await waitForTask(task.taskUid);
  // The next write has to recreate the index and reapply settings.
  preparedIndexes.delete(uid);
  return result;
}
