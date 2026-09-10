/**
 * Converts an arbitrary filename stem into an ASCII slug that satisfies the
 * Meilisearch primary-key rule (`[A-Za-z0-9_-]`).
 *
 * Accented Latin letters are folded to their base letter via NFKD, everything else
 * that is not ASCII alphanumeric collapses into a single hyphen. Korean and other
 * non-Latin scripts therefore produce an empty slug; the caller falls back to a
 * hash-only id in that case.
 */

const MAX_SLUG_LENGTH = 80;

/**
 * @param {string} input
 * @param {number} [maxLength]
 * @returns {string} lowercase ASCII slug, possibly empty
 */
export function toAsciiSlug(input: string, maxLength = MAX_SLUG_LENGTH) {
  if (typeof input !== 'string') return '';

  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics left by NFKD
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return slug.slice(0, maxLength).replace(/-+$/g, '');
}
