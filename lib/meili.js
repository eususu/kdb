import { config } from '../config.js';

const INDEX_SETTINGS = {
  searchableAttributes: ['filename', 'content'],
  // doc_id must be filterable so re-indexing can delete a document's old chunks,
  // and so search can collapse results per document via `distinct`.
  filterableAttributes: ['doc_id', 'filename', 'page', 'ocr'],
  sortableAttributes: ['page', 'indexed_at'],
  // The info endpoint counts chunks per document with a doc_id facet, and the default
  // cap of 100 facet values would silently truncate that list.
  faceting: { maxValuesPerFacet: 1000 }
};

/** Indexes whose settings have already been applied during this process lifetime. */
const preparedIndexes = new Set();

export async function request(path, { method = 'GET', body } = {}) {
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
    const error = new Error(`Meilisearch ${method} ${path} → HTTP ${response.status}: ${detail}`);
    error.meiliCode = data?.code;
    error.status = response.status;
    throw error;
  }

  return data;
}

/**
 * Meilisearch applies writes asynchronously. Waiting matters here because a failed
 * task otherwise looks like success to the caller.
 */
export async function waitForTask(taskUid, timeoutMs = 60_000) {
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
export async function ensureIndex(uid) {
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
        error.meiliCode === 'index_already_exists' || /already exists/i.test(error.message);
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
function quoteFilterValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Removes every chunk belonging to a document. Without this, re-indexing a file that
 * shrank from 20 to 15 pages would leave pages 16-20 behind as orphans.
 *
 * Matching on filename as well as doc_id matters whenever the id scheme changes: the
 * same file would otherwise produce a new doc_id and strand all of its previous chunks.
 */
export async function deleteDocumentChunks(uid, docId, filename) {
  const clauses = [`doc_id = ${quoteFilterValue(docId)}`];
  if (filename) clauses.push(`filename = ${quoteFilterValue(filename)}`);

  const task = await request(`/indexes/${uid}/documents/delete`, {
    method: 'POST',
    body: { filter: clauses.join(' OR ') }
  });
  return waitForTask(task.taskUid);
}

/** Adds documents in batches so a large PDF does not become one huge request body. */
export async function addDocuments(uid, documents, batchSize = 200) {
  const tasks = [];

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

export async function search(uid, body) {
  return request(`/indexes/${uid}/search`, { method: 'POST', body });
}

export async function indexExists(uid) {
  try {
    await request(`/indexes/${uid}`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

export async function getStats(uid) {
  return request(`/indexes/${uid}/stats`);
}

export async function getSettings(uid) {
  return request(`/indexes/${uid}/settings`);
}

/**
 * One entry per indexed document (not per chunk), newest first.
 * Chunk counts come from a doc_id facet because Meilisearch has no group-by.
 */
export async function summariseDocuments(uid, limit = 100) {
  const [faceted, listed] = await Promise.all([
    search(uid, { q: '', limit: 0, facets: ['doc_id'] }),
    search(uid, {
      q: '',
      limit,
      distinct: 'doc_id',
      attributesToRetrieve: ['doc_id', 'filename', 'total_pages', 'ocr', 'indexed_at'],
      sort: ['indexed_at:desc']
    })
  ]);

  const chunkCounts = faceted.facetDistribution?.doc_id ?? {};

  return {
    documentCount: Object.keys(chunkCounts).length,
    documents: (listed.hits ?? []).map((hit) => ({
      doc_id: hit.doc_id,
      filename: hit.filename,
      total_pages: hit.total_pages,
      chunks: chunkCounts[hit.doc_id] ?? null,
      ocr: hit.ocr,
      indexed_at: hit.indexed_at
    }))
  };
}

/** Empties an index but keeps it and its settings in place. */
export async function clearDocuments(uid) {
  const task = await request(`/indexes/${uid}/documents`, { method: 'DELETE' });
  return waitForTask(task.taskUid);
}

/** Drops the index entirely, settings included. */
export async function dropIndex(uid) {
  const task = await request(`/indexes/${uid}`, { method: 'DELETE' });
  const result = await waitForTask(task.taskUid);
  // The next write has to recreate the index and reapply settings.
  preparedIndexes.delete(uid);
  return result;
}
