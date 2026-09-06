import { config } from '../config.js';

const INDEX_SETTINGS = {
  searchableAttributes: ['filename', 'content'],
  // doc_id must be filterable so re-indexing can delete a document's old chunks,
  // and so search can collapse results per document via `distinct`.
  filterableAttributes: ['doc_id', 'filename', 'page', 'ocr'],
  sortableAttributes: ['page', 'indexed_at']
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

  try {
    const created = await request('/indexes', {
      method: 'POST',
      body: { uid, primaryKey: 'id' }
    });
    await waitForTask(created.taskUid);
  } catch (error) {
    if (error.meiliCode !== 'index_already_exists') throw error;
  }

  const updated = await request(`/indexes/${uid}/settings`, {
    method: 'PATCH',
    body: INDEX_SETTINGS
  });
  await waitForTask(updated.taskUid);

  preparedIndexes.add(uid);
}

/**
 * Removes every chunk belonging to a document. Without this, re-indexing a file that
 * shrank from 20 to 15 pages would leave pages 16-20 behind as orphans.
 */
export async function deleteDocumentChunks(uid, docId) {
  const task = await request(`/indexes/${uid}/documents/delete`, {
    method: 'POST',
    body: { filter: `doc_id = "${docId}"` }
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
