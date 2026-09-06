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

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`❌ 환경변수 ${name} 는 양수여야 합니다. 현재 값: ${raw}`);
    process.exit(1);
  }
  return parsed;
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
  maxUploadBytes: num('MAX_UPLOAD_MB', 50) * 1024 * 1024
};

if (!SAFE_ID.test(config.defaultIndex)) {
  console.error(`❌ DEFAULT_INDEX 는 영숫자, 하이픈, 언더스코어만 쓸 수 있습니다. 현재 값: ${config.defaultIndex}`);
  process.exit(1);
}

if (config.chunk.overlapChars >= config.chunk.maxChars) {
  console.error('❌ CHUNK_OVERLAP_CHARS 는 CHUNK_MAX_CHARS 보다 작아야 합니다. (무한 분할 방지)');
  process.exit(1);
}
