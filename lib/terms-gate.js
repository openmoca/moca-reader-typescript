// The terms gate's shared view of a set of packages (moca-spec Reader contract §15.3–15.4, ADR-0041): each node's
// resolved terms, and whether a package is closed or hidden for a request. Search, ingest, the structure operations
// and the catalogue all use it, so they agree on what is closed.
import { scopeCovers } from './attestations.js';
import { compositionOf, CompositionIndex } from './composition.js';
import { termsSourceOf } from './reader.js';
import { resolveAi, ratingOf, closureOf } from './terms.js';

/** What a package with no terms result counts as: every permission at its strictest (contract §15.3). */
export const STRICTEST_SOURCE = Object.freeze({
  terms: {
    ai: { allowed: { device: false, host: false, provider: false, training: false, machineTranslation: false, mention: false }, answerSources: 'work' },
    rights: { export: { allowed: false } },
  },
  authority: 'unverified',
});

const OPEN = Object.freeze({ closed: false, closedBy: [], hidden: false });

export class TermsResolver {
  /**
   * @param {object} options
   * @param {Array<{ digest: string, id: string, version: string, source: object|null, relationScopes?: string[] }>} options.packages
   * @param {CompositionIndex} [options.composition]
   * @param {boolean} [options.allowUnsigned]  the host lets unsigned composing packages speak for their members
   * @param {object} [options.termsLimits]  the host's own `ai` values: floors, never values
   * @param {object} [options.request]  the terms request, for closed and hidden
   */
  constructor({ packages, composition, allowUnsigned = false, termsLimits, request }) {
    this.byDigest = new Map(packages.map((p) => [p.digest, p]));
    this.composition = composition ?? null;
    this.allowUnsigned = allowUnsigned;
    this.termsLimits = termsLimits && typeof termsLimits === 'object' ? termsLimits : undefined;
    this.request = request;
    this.closures = new Map();
    this.hiddenNames = null;
  }

  /** The package's terms source, or the strictest when it has none. */
  source(digest) {
    return this.byDigest.get(digest)?.source ?? STRICTEST_SOURCE;
  }

  /**
   * Contract §15.3 step 3: the terms of the composing packages whose signers speak for this package, as for upTo
   * (§9), or of every composing package when the host allows unsigned ones. A composer with no terms result counts as
   * setting nothing.
   */
  composites(digest) {
    const id = this.byDigest.get(digest)?.id;
    const out = [];
    for (const composer of this.composition?.composersOf(digest) ?? []) {
      const scopes = this.byDigest.get(composer.digest)?.relationScopes;
      if (!this.allowUnsigned && !scopeCovers(Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string') : [], id)) continue;
      const c = this.byDigest.get(composer.digest)?.source;
      if (c?.terms) out.push(c.terms);
    }
    return out;
  }

  /** A node's resolved `ai` terms and effective rating, with the package source and composites they came from. */
  nodeTerms(digest, path) {
    const pkg = this.source(digest);
    const composites = this.composites(digest);
    return { pkg, composites, ai: resolveAi(pkg, path, this.termsLimits, composites), rating: ratingOf(pkg.terms, path) };
  }

  /** Contract §15.4: whether the package is closed, and hidden, for the request. */
  closure(digest) {
    if (!this.request?.ai) return OPEN;
    let c = this.closures.get(digest);
    if (!c) {
      c = closureOf(this.request, resolveAi(this.source(digest), null, this.termsLimits, this.composites(digest)));
      this.closures.set(digest, c);
    }
    return c;
  }

  /**
   * Contract §15.4, "Nothing names a hidden package": whether a reference (a package id, an id@version, or a node id
   * under either, as in trust.supersededBy and trust.contestedBy) names a package hidden for the request.
   */
  namesHidden(ref) {
    if (typeof ref !== 'string' || !this.request?.ai) return false;
    if (!this.hiddenNames) {
      this.hiddenNames = [];
      for (const [digest, p] of this.byDigest) if (this.closure(digest).hidden) this.hiddenNames.push(p.id, `${p.id}@${p.version}`);
    }
    return this.hiddenNames.some((n) => ref === n || ref.startsWith(`${n}#`));
  }

  /** A record's trust with the entries that name a hidden package left out of supersededBy and contestedBy. */
  withoutHidden(record) {
    const trust = record.trust;
    if (!trust || !(trust.supersededBy?.length || trust.contestedBy?.length)) return record;
    const next = { ...trust };
    for (const key of ['supersededBy', 'contestedBy']) {
      if (!Array.isArray(trust[key])) continue;
      const kept = trust[key].filter((ref) => !this.namesHidden(ref));
      if (kept.length > 0) next[key] = kept;
      else delete next[key];
    }
    return { ...record, trust: next };
  }
}

/** A resolver over a library's loaded packages. */
export function libraryResolver(library, { termsLimits, request } = {}) {
  return new TermsResolver({
    packages: library.packages.map(({ result }) => ({
      digest: result.digest, id: result.manifest.id, version: result.manifest.version, source: termsSourceOf(result), relationScopes: result.relationScopes ?? [],
    })),
    composition: new CompositionIndex(library.packages.map(({ result }) => ({ digest: result.digest, composition: compositionOf(result) }))),
    allowUnsigned: library.allowUnsignedRelations === true,
    termsLimits,
    request,
  });
}

/** A resolver over package states (contract §9.4), for a store search. */
export function stateResolver(states, { composition, allowUnsigned, termsLimits, request } = {}) {
  return new TermsResolver({
    packages: [...states.values()].map((s) => ({ digest: s.digest, id: s.id, version: s.version, source: s.terms ?? null, relationScopes: s.relationScopes ?? [] })),
    composition,
    allowUnsigned,
    termsLimits,
    request,
  });
}

/** The U004 finding's counts (contract §15.4): removed records by reason, and how many came from hidden packages. */
export class TermsCount {
  constructor() {
    this.reasons = new Map();
    this.hidden = 0;
  }

  add(reasons, hidden) {
    for (const r of reasons) this.reasons.set(r, (this.reasons.get(r) ?? 0) + 1);
    if (hidden) this.hidden++;
  }

  get size() {
    return this.reasons.size;
  }

  /** Adds U004 to a Diagnostics, with `excluded` and `hidden`, when anything was removed. */
  report(diagnostics, what) {
    if (this.reasons.size === 0) return null;
    const sorted = [...this.reasons].sort(([a], [b]) => (a < b ? -1 : 1));
    const counts = sorted.map(([k, n]) => `${k}: ${n}`).join(', ');
    const entry = diagnostics.add('U004_TERMS_EXCLUDED', `the terms request removed ${what} (${counts}; from hidden packages: ${this.hidden})`);
    entry.excluded = Object.fromEntries(sorted);
    entry.hidden = this.hidden;
    return entry;
  }
}
