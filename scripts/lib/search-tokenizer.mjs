const HAN_RUN_PATTERN = /\p{Script=Han}+/gu;
const LATIN_TOKEN_PATTERN = /[\p{Letter}\p{Number}]+(?:[._-][\p{Letter}\p{Number}]+)*/gu;

function addToken(tokens, value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized) tokens.add(normalized);
}

/**
 * Builds a compact, language-neutral token set for Typesense.
 * Typesense's default tokenizer can drop parts of a Chinese query. Overlapping
 * Han bigrams/trigrams keep short Chinese terms searchable without downloading
 * a dictionary or changing the source content.
 */
export function tokenizeSearchText(value, {maxTokens = 5000} = {}) {
  const text = String(value ?? '').toLowerCase();
  const tokens = new Set();

  for (const match of text.matchAll(LATIN_TOKEN_PATTERN)) addToken(tokens, match[0]);

  for (const match of text.matchAll(HAN_RUN_PATTERN)) {
    const run = match[0];
    if (run.length <= 4) addToken(tokens, run);
    const characters = Array.from(run);
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= characters.length; index += 1) {
        addToken(tokens, characters.slice(index, index + size).join(''));
        if (tokens.size >= maxTokens) return Array.from(tokens).sort();
      }
    }
  }

  return Array.from(tokens).sort();
}

export function buildSearchTokens(values, options) {
  const text = (Array.isArray(values) ? values : [values])
    .filter((value) => value !== undefined && value !== null)
    .join(' ');
  return tokenizeSearchText(text, options);
}
