// BM25 over plain text, shared by the lexical and in-memory store backends.
//
// Tokens. Every Reader's built-in lexical backend tokenises the same way, so
// they return the same results:
// 1. NFKC-normalise the text, then lower-case it as package spec §6.3 does
//    (lib/unicode.js: the simple mapping, one code point at a time).
// 2. Letters, digits and combining marks (\p{L}, \p{N}, \p{M}) are word
//    characters; anything else separates words. Keeping marks inside words
//    keeps Devanagari, Arabic and other scripts with vowel signs whole.
// 3. Scripts written without spaces (Chinese, Japanese kana, Thai, Lao,
//    Khmer, Myanmar; the ranges below) are split into units, each character
//    with the combining marks after it, and indexed as each unit and each pair
//    of neighbouring units, so a query matches without a dictionary.
// No stemming: hosts that need it supply their own lexical backend.
import { lowerCodePoint } from '../unicode.js';

const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
const MARK = /^\p{M}$/u;

// Code point ranges written without spaces between words.
export const UNSPACED = Object.freeze([
  [0x0e00, 0x0eff], // Thai, Lao
  [0x1000, 0x109f], // Myanmar
  [0x1780, 0x17ff], // Khmer
  [0x3040, 0x30ff], // Hiragana, Katakana
  [0x31f0, 0x31ff], // Katakana phonetic extensions
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0x20000, 0x3ffff], // CJK extensions B and later
]);

const unspaced = (cp) => UNSPACED.some(([from, to]) => cp >= from && cp <= to);

export function tokens(text) {
  const out = [];
  let run = [];
  let runUnspaced = false;
  const flush = () => {
    if (run.length === 0) return;
    if (!runUnspaced) out.push(run.join(''));
    else {
      for (let i = 0; i < run.length; i++) {
        out.push(run[i]);
        if (i + 1 < run.length) out.push(run[i] + run[i + 1]);
      }
    }
    run = [];
  };
  for (const ch of text.normalize('NFKC')) {
    const c = lowerCodePoint(ch);
    if (!WORD_CHAR.test(c)) {
      flush();
      continue;
    }
    const u = unspaced(c.codePointAt(0));
    if (u && runUnspaced && run.length > 0 && MARK.test(c)) {
      run[run.length - 1] += c;
      continue;
    }
    if (run.length > 0 && u !== runUnspaced) flush();
    runUnspaced = u;
    run.push(c);
  }
  flush();
  return out;
}

/**
 * @template T
 * @param {Array<{ item: T, text: string, key: string }>} docs  key breaks ties
 * @param {string} query
 * @returns {Array<{ item: T, score: number }>} best first, zero scores dropped
 */
export function bm25(docs, query, k1 = 1.2, b = 0.75) {
  return bm25Counted(docs.map((d) => ({ item: d.item, key: d.key, counts: countTerms(d.text) })), query, k1, b);
}

/**
 * A text's term frequencies and length in tokens: all BM25 needs of it.
 *
 * @param {string} text
 * @returns {{ terms: Map<string, number>, length: number }}
 */
export function countTerms(text) {
  const t = tokens(text);
  const terms = new Map();
  for (const term of t) terms.set(term, (terms.get(term) ?? 0) + 1);
  return { terms, length: t.length };
}

/**
 * bm25() over documents already counted, so a backend can count each document once and keep it. The same
 * arithmetic in the same order, so scores are identical.
 *
 * @template T
 * @param {Array<{ item: T, key: string, counts: { terms: Map<string, number>, length: number } }>} docs
 * @param {string} query
 * @returns {Array<{ item: T, score: number }>} best first, zero scores dropped
 */
export function bm25Counted(docs, query, k1 = 1.2, b = 0.75) {
  const q = [...new Set(tokens(query))];
  if (q.length === 0 || docs.length === 0) return [];
  const avg = docs.reduce((s, d) => s + d.counts.length, 0) / docs.length || 1;
  const df = new Map(q.map((term) => [term, docs.filter((d) => d.counts.terms.has(term)).length]));
  const scored = docs.map((d) => {
    const { terms, length } = d.counts;
    let score = 0;
    for (const term of q) {
      const f = terms.get(term) ?? 0;
      if (f === 0) continue;
      const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * length) / avg)));
    }
    return { item: d.item, key: d.key, score: Math.round(score * 1e4) / 1e4 };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || (a.key < b2.key ? -1 : a.key > b2.key ? 1 : 0))
    .map(({ item, score }) => ({ item, score }));
}
