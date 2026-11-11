// Hybrid backend: a lexical and a dense backend merged by Reciprocal Rank
// Fusion (spec/moca-reader-contract.md §9.6).
//
//   score(hit) = Σ weight_b / (k + rank_b(hit))
//
// rank_b is the hit's 1-based position in backend b's results. k (default 60)
// and the weights (default 1) are the host's; a package never sets them. A
// package the dense backend cannot search (S006, S007) still comes back
// through the lexical side.

/** Identity of a hit: equal digest, node, locale and span. */
const keyOf = (h) => `${h.digest}\u0000${h.node}\u0000${h.locale ?? ''}\u0000${h.span?.start ?? ''}\u0000${h.span?.end ?? ''}`;

/** Ties: node id, then locale, then span start; the same order in every Reader. */
function tieBreak(a, b) {
  const ka = [a.node, a.locale ?? ''];
  const kb = [b.node, b.locale ?? ''];
  for (let i = 0; i < 2; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return (a.span?.start ?? -1) - (b.span?.start ?? -1);
}

const checkWeight = (name, w) => {
  if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) throw new RangeError(`weights.${name} must be a number of at least 0`);
  return w;
};

export class HybridBackend {
  /**
   * @param {{ lexical: import('../search.js').SearchBackend, dense: import('../search.js').SearchBackend,
   *   k?: number, weights?: { lexical?: number, dense?: number } }} options
   */
  constructor({ lexical, dense, k = 60, weights = {} }) {
    if (typeof lexical?.search !== 'function' || typeof dense?.search !== 'function') throw new TypeError('HybridBackend needs a lexical and a dense backend');
    if (typeof k !== 'number' || !Number.isFinite(k) || k < 0) throw new RangeError('k must be a number of at least 0');
    this.lexical = lexical;
    this.dense = dense;
    this.k = k;
    this.weights = { lexical: checkWeight('lexical', weights.lexical ?? 1), dense: checkWeight('dense', weights.dense ?? 1) };
    if (this.weights.lexical === 0 && this.weights.dense === 0) throw new RangeError('at least one weight must be above 0');
    const pushdown = [lexical, dense].every((b) => b.features?.includes('filterPushdown'));
    this.features = ['lexical', 'dense', ...(pushdown ? ['filterPushdown'] : [])];
  }

  /** Both backends' findings, such as S006 and S007 from the dense side. */
  get diagnostics() {
    return [...(this.lexical.diagnostics ?? []), ...(this.dense.diagnostics ?? [])];
  }

  /** @returns {Promise<import('../search.js').SearchHit[]>} */
  async search(query, { limit, filters }) {
    const [lexical, dense] = await Promise.all([
      this.lexical.search(query, { limit, filters }),
      this.dense.search(query, { limit, filters }),
    ]);
    const fused = new Map();
    const add = (hits, weight) => {
      if (weight === 0 || !Array.isArray(hits)) return;
      hits.forEach((hit, i) => {
        const key = keyOf(hit);
        const entry = fused.get(key) ?? { hit, score: 0 };
        entry.score += weight / (this.k + i + 1);
        fused.set(key, entry);
      });
    };
    add(lexical, this.weights.lexical);
    add(dense, this.weights.dense);
    return [...fused.values()]
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score || tieBreak(a.hit, b.hit))
      .slice(0, limit)
      .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 1e6) / 1e6 }));
  }
}
