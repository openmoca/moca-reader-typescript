// The Reader's search: spec/moca-reader-contract.md §9 and §10.
//
// Pipeline: ingress hook -> backend -> resolve hits into citation records ->
// egress hook -> the gate. Backends and hooks only propose candidates; the
// gate (digest allowlist, default retrieval policy, audience, locale,
// concepts and scope) always runs last, so nothing either of them does can
// return content the policy excludes.
import { refreshRecord, stateIndex } from './state.js';
import { audienceAllowed, recordAudience } from './audience.js';
import { parseInstant } from './dates.js';
import { citationFor, passesDefaultPolicy, pickRepresentation } from './citation.js';

const MAX_FETCH = 200;

/**
 * @typedef {object} SearchHit  schemas/v1/search-hit.schema.json
 * @property {string} digest
 * @property {string} node
 * @property {string} path
 * @property {string} [locale]
 * @property {{ start: number, end: number }} [span]
 * @property {number} score
 * @property {object} [record]  a citation record written at ingest (store backends)
 *
 * @typedef {object} SearchFilters  spec/moca-reader-contract.md §9.4
 * @property {string[]} digests
 * @property {Array<{ digest: string, node: string }>} exclude
 * @property {string[]} [audiences]
 * @property {string} [locale]
 * @property {string[]} [concepts]
 *
 * @typedef {object} SearchBackend
 * @property {string[]} features  lexical | dense, plus filterPushdown
 * @property {(query: string, options: { limit: number, filters: SearchFilters }) => SearchHit[]|Promise<SearchHit[]>} search
 * @property {object[]} [diagnostics]
 *
 * @typedef {object} Embedder  supplied by the host, never by a package
 * @property {string} name
 * @property {string} [version]
 * @property {number} dimensions
 * @property {string} [queryPrefix]     declared for comparison with an index, never applied by the Reader
 * @property {string} [documentPrefix]  declared for comparison with an index, never applied by the Reader
 * @property {(texts: string[], options?: { role: 'query'|'document' }) => number[][]|Promise<number[][]>} embed
 *   the embedder applies its model's convention for the role (Reader interface §5.3)
 *
 * @typedef {object} SearchOptions
 * @property {number} [limit]         default 5
 * @property {boolean} [includeAll]   the host's opt-in to content §8 excludes
 * @property {string} [locale]
 * @property {string[]} [concepts]    concept IRIs; keep records bound to any of them
 * @property {string} [scope]         a concept IRI; keep records bound to it or its descendants
 *
 * @typedef {object} SearchHooks  host code, never package content (moca-spec ADR-0010)
 * @property {(query: string, ctx: object) => ({ query?: string, concepts?: string[], scope?: string }|void|Promise<object|void>)} [ingress]
 * @property {(candidates: object[], ctx: object) => (object[]|Promise<object[]>)} [egress]
 */

export class Search {
  /**
   * @param {import('./library.js').Library | { packages: object[], clock?: () => Date, allowUnsignedRelations?: boolean }} source
   *   a Library, or, for a store backend, the states of the packages the host
   *   has loaded (packageState) and a clock: store hits resolve from their
   *   ingest-time records, with every library- and trust-dependent field
   *   recomputed (contract §9.4).
   * @param {{ backend: SearchBackend, audiences?: string[], overfetch?: number, hooks?: SearchHooks }} options
   */
  constructor(source, { backend, audiences, allowUnlabelled = false, overfetch = 3, hooks = {} }) {
    if (!backend || typeof backend.search !== 'function') throw new TypeError('Search needs a backend');
    this.library = typeof source?.relationIndex === 'function' ? source : null;
    // Contract §9.4: a store search takes the host's package states, so it can
    // recompute every field that depends on the library or the trust root.
    this.states = this.library ? null : new Map((source?.packages ?? []).map((s) => [s.digest, s]));
    this.allowed = this.library ? null : new Set(this.states.keys());
    this.storeIndex = this.library ? null : stateIndex(this.states, { allowUnsignedRelations: source?.allowUnsignedRelations === true });
    this.clock = this.library ? () => this.library.clock() : (source?.clock ?? (() => new Date()));
    this.backend = backend;
    this.audiences = audiences ? [...audiences] : undefined;
    // Contract §8 (moca-spec ADR-0016): unlabelled content is outside an audience set unless the host allows it.
    this.allowUnlabelled = allowUnlabelled === true;
    this.overfetch = overfetch;
    this.hooks = hooks;
  }

  /**
   * @param {string} query
   * @param {SearchOptions} [options]
   */
  async search(query, options = {}) {
    const ctx = this.#context(options);
    if (this.hooks.ingress) applyIngress(ctx, await this.hooks.ingress(query, ctx.hookContext));
    const plan = this.#plan(ctx);
    const hits = await this.backend.search(ctx.request.query ?? query, plan);
    let candidates = this.#resolve(hits, ctx);
    if (this.hooks.egress) candidates = await this.hooks.egress(candidates.map((r) => ({ ...r, retrieval: { via: 'search' } })), ctx.hookContext);
    return this.#gate(candidates, ctx);
  }

  /** As search(), for a synchronous backend and no asynchronous hooks. */
  searchSync(query, options = {}) {
    const ctx = this.#context(options);
    if (this.hooks.ingress) {
      const r = this.hooks.ingress(query, ctx.hookContext);
      if (typeof r?.then === 'function') throw new TypeError('the ingress hook is asynchronous; use search()');
      applyIngress(ctx, r);
    }
    const hits = this.backend.search(ctx.request.query ?? query, this.#plan(ctx));
    if (typeof hits?.then === 'function') throw new TypeError('this backend is asynchronous; use search()');
    let candidates = this.#resolve(hits, ctx);
    if (this.hooks.egress) {
      candidates = this.hooks.egress(candidates.map((r) => ({ ...r, retrieval: { via: 'search' } })), ctx.hookContext);
      if (typeof candidates?.then === 'function') throw new TypeError('the egress hook is asynchronous; use search()');
    }
    return this.#gate(candidates, ctx);
  }

  #context({ limit = 5, includeAll = false, locale, concepts, scope } = {}) {
    const now = this.clock();
    const index = this.library?.relationIndex();
    // The caller's request binds the gate. Ingress may change the query and
    // what the backend searches (contract §9.2), never the limit, the opt-in,
    // the locale or what the gate keeps.
    const caller = Object.freeze({ limit, includeAll, locale, concepts: concepts?.length ? Object.freeze([...concepts]) : undefined, scope });
    const request = { ...caller };
    const loaded = new Map((this.library?.packages ?? []).map((p) => [p.result.digest, p.result]));
    const hookContext = Object.freeze({
      get request() { return Object.freeze({ ...request }); },
      library: this.library,
      structure: this.library?.structure ?? null,
      audiences: this.audiences,
      now,
    });
    return { now, index, request, caller, loaded, hookContext };
  }

  #plan({ now, index, request }) {
    const exclude = [];
    if (!request.includeAll && this.library) {
      for (const { result } of this.library.packages) {
        for (const node of result.nodes) {
          const allExcluded = node.representations.every((rep) => !passesDefaultPolicy(citationFor(result, node, rep, { now, index })));
          if (allExcluded) exclude.push({ digest: result.digest, node: `${result.manifest.id}#${node.path}` });
        }
      }
    }
    const concepts = this.#concepts(request);
    const filters = {
      digests: this.library ? this.library.packages.map((p) => p.result.digest) : [...this.allowed],
      exclude,
      ...(this.audiences ? { audiences: this.audiences, allowUnlabelled: this.allowUnlabelled } : {}),
      ...(request.locale ? { locale: request.locale } : {}),
      ...(concepts ? { concepts } : {}),
    };
    // Fetch more than the limit when the gate may drop hits (no pushdown), or
    // when an egress hook reorders them and needs candidates to choose from.
    const pushdown = this.backend.features?.includes('filterPushdown');
    const fetch = pushdown && !this.hooks.egress ? request.limit : Math.min(request.limit * this.overfetch, MAX_FETCH);
    return { limit: fetch, filters };
  }

  /** The concepts a record must be bound to: the caller's, plus a scope and its descendants. */
  #concepts(request) {
    const set = new Set(request.concepts ?? []);
    if (request.scope) {
      set.add(request.scope);
      for (const c of this.library?.structure?.descendants(request.scope) ?? []) set.add(c);
    }
    return set.size > 0 ? [...set] : undefined;
  }

  /** Turns backend hits into citation records; hits that do not resolve are dropped. */
  #resolve(hits, { now, index, loaded }) {
    const out = [];
    for (const hit of Array.isArray(hits) ? hits : []) {
      if (hit?.record) {
        const refreshed = this.library ? refreshClock(hit.record, now) : refreshRecord(hit.record, now, this.states, this.storeIndex);
        if (refreshed) out.push({ ...refreshed, score: hit.score });
        continue;
      }
      const result = loaded.get(hit?.digest);
      if (!result || hit.node !== `${result.manifest.id}#${hit.path}`) continue;
      const node = result.nodes.find((n) => n.path === hit.path);
      const rep = node?.representations.find((r) => (r.locale ?? null) === (hit.locale ?? null));
      if (!rep) continue;
      const text = hit.span ? sliceBody(rep, hit.span) : rep.body;
      if (text === null) continue;
      const record = citationFor(result, node, rep, { now, index, text });
      if (hit.span) record.span = { start: hit.span.start, end: hit.span.end };
      out.push({ ...record, score: hit.score });
    }
    return out;
  }

  /** The gate: always last, whatever the backend and the hooks did. */
  #gate(candidates, { caller, loaded }) {
    const request = caller;
    const concepts = this.#concepts(caller);
    const allowed = this.library ? new Set(loaded.keys()) : this.allowed;
    const seen = new Set();
    const out = [];
    for (const record of Array.isArray(candidates) ? candidates : []) {
      if (!record?.package || !record?.node || !record?.trust) continue;
      if (!allowed.has(record.package.digest)) continue;
      if (!request.includeAll && !passesDefaultPolicy(record)) continue;
      if (!audienceAllowed(recordAudience(record), this.audiences, this.allowUnlabelled)) continue;
      if (request.locale && !this.#localeOk(record, request.locale, loaded)) continue;
      if (concepts && !(record.concepts ?? []).some((c) => concepts.includes(c))) continue;
      // Contract §9.2: one result per node representation and span.
      const key = `${record.node.ref}\u0000${record.node.locale ?? ''}\u0000${record.span?.start ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(record);
    }
    if (!this.hooks.egress) out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return out.slice(0, request.limit);
  }

  #localeOk(record, locale, loaded) {
    const result = loaded.get(record.package.digest);
    const node = result?.nodes.find((n) => n.path === record.node.path);
    if (!node) {
      const want = locale.toLowerCase();
      const have = (record.node.locale ?? '').toLowerCase();
      return have === want || want.startsWith(`${have}-`) || have.startsWith(`${want}-`);
    }
    const rep = pickRepresentation(node, locale);
    return (rep.locale ?? result.manifest.language ?? null) === (record.node.locale ?? null);
  }
}

/** Applies what an ingress hook may change: the query, and the concepts or scope the backend searches. */
function applyIngress({ request }, result) {
  if (!result || typeof result !== 'object') return;
  if (typeof result.query === 'string') request.query = result.query;
  if (Array.isArray(result.concepts)) request.concepts = [...result.concepts];
  if (typeof result.scope === 'string') request.scope = result.scope;
}

/** A stored citation record with its clock-dependent fields recomputed for now. */
function refreshClock(record, now) {
  const t = now.getTime();
  const trust = { ...record.trust };
  trust.stale = trust.staleAfter ? t >= parseInstant(trust.staleAfter) : false;
  trust.inForce = (!trust.validFrom || t >= parseInstant(trust.validFrom)) && (!trust.validUntil || t < parseInstant(trust.validUntil));
  return { ...record, trust };
}

/** The text of a byte span that lies inside a representation's body, or null. */
function sliceBody(rep, { start, end }) {
  const body = Buffer.from(rep.body, 'utf8');
  const from = start - rep.bodyOffset;
  const to = end - rep.bodyOffset;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > body.length) return null;
  return body.subarray(from, to).toString('utf8');
}
