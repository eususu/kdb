// Loads configuration from .env (Node 22+ built-in loader) and validates it once at boot.
try {
  process.loadEnvFile();
} catch {
  // No .env present. Fall through to real environment variables.
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ 환경변수 ${name} 가 설정되지 않았습니다. .env.example 을 참고해 .env 를 만들어 주세요.`);
    process.exit(1);
  }
  return value;
}

function num(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    console.error(`❌ 환경변수 ${name} 는 ${allowZero ? '0 이상' : '양수'}여야 합니다. 현재 값: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Meilisearch index uids and document ids share the same character rules. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,400}$/;

export const config = {
  meiliUrl: (process.env.MEILI_URL || 'http://localhost:7700').replace(/\/+$/, ''),
  meiliKey: required('MEILI_MASTER_KEY'),
  tikaUrl: (process.env.TIKA_URL || 'http://localhost:9998').replace(/\/+$/, ''),
  port: num('PORT', 3000),
  defaultIndex: process.env.DEFAULT_INDEX || 'my_docs',
  chunk: {
    minChars: num('CHUNK_MIN_CHARS', 80),
    maxChars: num('CHUNK_MAX_CHARS', 4000),
    overlapChars: num('CHUNK_OVERLAP_CHARS', 200)
  },
  maxUploadBytes: num('MAX_UPLOAD_MB', 50) * 1024 * 1024,
  ocr: {
    // OCR needs a vision model, so it is only available when OLLAMA_URL is set.
    enabled: bool('OCR_ENABLED', true) && Boolean(process.env.OLLAMA_URL),
    ollamaUrl: (process.env.OLLAMA_URL || '').replace(/\/+$/, ''),
    model: process.env.OCR_MODEL || 'qwen3.6:35b',
    // A page holding fewer characters than this is treated as "no text extracted".
    // Default 1 means only completely empty pages qualify, which keeps OCR from
    // overwriting short but valid pages such as covers and section dividers.
    minChars: num('OCR_MIN_CHARS', 1, { allowZero: true }),
    // Render scale. 2 gives roughly 144 DPI, enough for the models to read body text.
    scale: num('OCR_SCALE', 2),
    // Vision inference runs about 10s per page, so cap how much one upload can trigger.
    maxPages: num('OCR_MAX_PAGES', 20),
    timeoutMs: num('OCR_TIMEOUT_MS', 120_000),
    concurrency: num('OCR_CONCURRENCY', 1)
  }
};

if (!SAFE_ID.test(config.defaultIndex)) {
  console.error(`❌ DEFAULT_INDEX 는 영숫자, 하이픈, 언더스코어만 쓸 수 있습니다. 현재 값: ${config.defaultIndex}`);
  process.exit(1);
}

if (config.chunk.overlapChars >= config.chunk.maxChars) {
  console.error('❌ CHUNK_OVERLAP_CHARS 는 CHUNK_MAX_CHARS 보다 작아야 합니다. (무한 분할 방지)');
  process.exit(1);
}
