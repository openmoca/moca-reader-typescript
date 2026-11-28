// The Reader's search: spec/moca-reader-contract.md §9 and §10.
//
// Pipeline: ingress hook -> backend -> resolve hits into citation records ->
// egress hook -> the gate. Backends and hooks only propose candidates; the
// gate (digest allowlist, default retrieval policy, audience, locale,
// concepts and scope) always runs last, so nothing either of them does can
// return content the policy excludes.
import { refreshRecord, stateIndex, storedFileKept, storedNode } from './state.js';
import { readingOrderOf } from './reader.js';
import { passesUpTo, readingOrderFromState } from './reading-order.js';
import { compositionOf, CompositionIndex } from './composition.js';
import { scopeCovers } from './attestations.js';
import { audienceAllowed, recordAudience } from './audience.js';
import { parseInstant } from './dates.js';
import { Diagnostics } from './diagnostics.js';
import { gateReasons, recordTerms, resolveExport } from './terms.js';
import { libraryResolver, stateResolver, TermsCount } from './terms-gate.js';
import { citationFor, passesDefaultPolicy, pickRepresentation } from './citation.js';
import { localeList, localeMatches, representationTag } from './locale.js';

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
 * @property {string[]} [locale]  the caller's priority list
 * @property {boolean} [everyRepresentation]  the Reader applies the locale in the gate: keep every representation
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
 * @property {string|string[]} [locale]  a language tag or a priority list (package spec §5.4)
 * @property {string[]} [concepts]    concept IRIs; keep records bound to any of them
 * @property {string} [scope]         a concept IRI; keep records bound to it or its descendants
 * @property {string} [upTo]          a member of a reading order; leave out what comes after it (contract §9)
 * @property {{ ai?: { destination?: string, conditions?: string[], use?: string }, rating?: object }} [terms]
 *   the host's terms request (contract §15.4): without it, terms remove nothing
 *
 * @typedef {object} SearchHooks  host code, never package content (moca-spec ADR-0010)
 * @property {(query: string, ctx: object) => ({ query?: string, concepts?: string[], scope?: string }|void|Promise<object|void>)} [ingress]
 * @property {(candidates: object[], ctx: object) => (object[]|Promise<object[]>)} [egress]
 */

export class Search {
  /**
   * @param {import('./library.js').Library | { packages: object[], allow?: string[], clock?: () => Date, allowUnsignedRelations?: boolean, structure?: import('./library.js').Library }} source
   *   a Library, or, for a store backend, the states of the packages the host
   *   has loaded (packageState) and a clock: store hits resolve from their
   *   ingest-time records, with every library- and trust-dependent field
   *   recomputed (contract §9.4). `structure`: the store search's structure
   *   source, a library of packages the host has read (a show and its seasons)
   *   whose structure the hooks see and `scope` follows; it adds no records.
   *   `allow`: the digests the host has loaded, when it could not get the
   *   state of every one; unset, the states' digests. A digest with no state is
   *   missing (contract §9.4): this Reader keeps no index of the store, so it
   *   cannot tell which records a missing state composes or acts on, and
   *   withholds every record, reporting S011_STATE_MISSING.
   * @param {{ backend: SearchBackend, audiences?: string[], overfetch?: number, hooks?: SearchHooks, maxCandidates?: number }} options
   *   maxCandidates: the host's bound on the candidates one search call examines (contract §9.2); unset, no bound.
   */
  constructor(source, { backend, audiences, allowUnlabelled = false, overfetch = 3, hooks = {}, maxCandidates, termsLimits } = {}) {
    if (!backend || typeof backend.search !== 'function') throw new TypeError('Search needs a backend');
    if (maxCandidates !== undefined && !(Number.isInteger(maxCandidates) && maxCandidates >= 1)) throw new RangeError('maxCandidates must be an integer of at least 1');
    if (!(Number.isInteger(overfetch) && overfetch >= 1)) throw new RangeError('overfetch must be an integer of at least 1');
    this.library = typeof source?.relationIndex === 'function' ? source : null;
    // Contract §9.4: a store search takes the host's package states, so it can
    // recompute every field that depends on the library or the trust root.
    this.states = this.library ? null : new Map((source?.packages ?? []).map((s) => [s.digest, s]));
    this.allowed = this.library ? null : new Set(Array.isArray(source?.allow) ? source.allow : this.states.keys());
    // Contract §9.4: loaded packages whose state the host could not get.
    this.missing = this.library ? [] : [...this.allowed].filter((d) => !this.states.has(d));
    this.storeIndex = this.library ? null : stateIndex(this.states, { allowUnsignedRelations: source?.allowUnsignedRelations === true });
    // Contract §9, Members: with the host's opt-in for its own packages, unsigned composers limit their members too.
    this.allowUnsigned = this.library ? this.library.allowUnsignedRelations === true : source?.allowUnsignedRelations === true;
    this.clock = this.library ? () => this.library.clock() : (source?.clock ?? (() => new Date()));
    // Contract §9.4: the structure the hooks and scope see; a store search's comes from its structure source.
    this.structure = this.library ? this.library.structure : (source?.structure?.structure ?? null);
    this.backend = backend;
    this.audiences = audiences ? [...audiences] : undefined;
    // Contract §8 (moca-spec ADR-0016): unlabelled content is outside an audience set unless the host allows it.
    this.allowUnlabelled = allowUnlabelled === true;
    this.overfetch = overfetch;
    this.maxCandidates = maxCandidates;
    this.hooks = hooks;
    // Contract §15.3 step 4: the host's own `ai` values, floors that only tighten.
    this.termsLimits = termsLimits && typeof termsLimits === 'object' ? termsLimits : undefined;
    /** The findings of the latest search() call, such as S008 (Reader interface §5.1). */
    this.diagnostics = [];
  }

  /**
   * @param {string} query
   * @param {SearchOptions} [options]
   */
  async search(query, options = {}) {
    const ctx = this.#context(options);
    if (this.hooks.ingress) applyIngress(ctx, await this.hooks.ingress(query, ctx.hookContext));
    const plan = this.#plan(ctx);
    // Contract §9.2, "Filters come before the limit": ask again, for more each time, until limit records pass the
    // gate or the backend has no more.
    for (let size = plan.limit; ; size = this.#next(size)) {
      const hits = await this.backend.search(ctx.request.query ?? query, { limit: size, filters: plan.filters });
      let candidates = this.#narrow(this.#resolve(hits, ctx), ctx);
      if (this.hooks.egress) candidates = await this.hooks.egress(candidates.map((r) => ({ ...r, retrieval: { via: 'search' } })), ctx.hookContext);
      const passed = this.#gate(candidates, ctx);
      if (this.#done(passed, hits, size, ctx)) return this.#finish(passed, ctx);
    }
  }

  /**
   * The records the caller keeps, and the terms gate's counts (U004, contract §15.4): by reason, and how many came
   * from packages hidden for the request.
   */
  #finish(passed, ctx) {
    const kept = passed.slice(0, ctx.caller.limit);
    if (ctx.termsExcluded?.report(ctx.findings, 'records')) this.diagnostics = ctx.findings.items;
    // Contract §9.4: records withheld because a state they depend on was missing, never returned as if unlimited.
    if (ctx.withheld > 0) {
      ctx.findings.add('S011_STATE_MISSING', `${ctx.withheld} records withheld: the state of ${this.missing.length} loaded packages was not given`);
      this.diagnostics = ctx.findings.items;
    }
    return kept;
  }

  /** As search(), for a synchronous backend and no asynchronous hooks. */
  searchSync(query, options = {}) {
    const ctx = this.#context(options);
    if (this.hooks.ingress) {
      const r = this.hooks.ingress(query, ctx.hookContext);
      if (typeof r?.then === 'function') throw new TypeError('the ingress hook is asynchronous; use search()');
      applyIngress(ctx, r);
    }
    const plan = this.#plan(ctx);
    for (let size = plan.limit; ; size = this.#next(size)) {
      const hits = this.backend.search(ctx.request.query ?? query, { limit: size, filters: plan.filters });
      if (typeof hits?.then === 'function') throw new TypeError('this backend is asynchronous; use search()');
      let candidates = this.#narrow(this.#resolve(hits, ctx), ctx);
      if (this.hooks.egress) {
        candidates = this.hooks.egress(candidates.map((r) => ({ ...r, retrieval: { via: 'search' } })), ctx.hookContext);
        if (typeof candidates?.then === 'function') throw new TypeError('the egress hook is asynchronous; use search()');
      }
      const passed = this.#gate(candidates, ctx);
      if (this.#done(passed, hits, size, ctx)) return this.#finish(passed, ctx);
    }
  }

  /** The next, larger request: double, up to the host's bound. */
  #next(size) {
    const doubled = size * 2;
    return this.maxCandidates ? Math.min(doubled, this.maxCandidates) : doubled;
  }

  /**
   * Whether a round is the last: limit records passed the gate, the backend returned fewer hits than asked (it has
   * no more), or the host's bound is reached, which is reported (S010).
   */
  #done(passed, hits, size, ctx) {
    if (passed.length >= ctx.caller.limit) return true;
    if (!Array.isArray(hits) || hits.length < size) return true;
    if (this.maxCandidates && size >= this.maxCandidates) {
      ctx.findings.add('S010_SEARCH_TRUNCATED', `stopped at maxCandidates ${this.maxCandidates} with ${passed.length} of ${ctx.caller.limit} records`);
      this.diagnostics = ctx.findings.items;
      return true;
    }
    return false;
  }

  #context({ limit = 5, includeAll = false, locale, concepts, scope, upTo, terms } = {}) {
    const now = this.clock();
    const index = this.library?.relationIndex();
    // The caller's request binds the gate. Ingress may change the query and
    // what the backend searches (contract §9.2), never the limit, the opt-in,
    // the locale or what the gate keeps.
    // Contract §15.4: the terms request is the caller's; a hook can never widen it.
    const termsRequest = terms && typeof terms === 'object' ? structuredClone(terms) : undefined;
    // Package spec §5.4: a locale is a tag or a priority list; an empty list is no locale.
    const locales = localeList(locale);
    const caller = Object.freeze({ limit, includeAll, locale: locales.length > 0 ? Object.freeze(locales) : undefined, concepts: concepts?.length ? Object.freeze([...concepts]) : undefined, scope, upTo, terms: termsRequest });
    const request = { ...caller };
    const loaded = new Map((this.library?.packages ?? []).map((p) => [p.result.digest, p.result]));
    const findings = new Diagnostics();
    // Contract §9: an upTo that no loaded reading order places limits nothing, and never silently.
    if (typeof upTo === 'string') {
      const digests = this.library ? [...loaded.keys()] : [...this.states.keys()];
      if (!digests.some((d) => this.#readingOrder(d, loaded)?.positions.has(upTo))) {
        findings.add('S008_UPTO_UNRESOLVED', `upTo ${upTo} is on no loaded package's reading order; it limits nothing`);
      }
    }
    this.diagnostics = findings.items;
    // Package spec §5.6: what each loaded composing package binds its members to.
    const composition = new CompositionIndex(this.library
      ? [...loaded.values()].map((r) => ({ digest: r.digest, composition: compositionOf(r) }))
      : [...this.states.values()]);
    // Contract §15.3–15.4: each node's resolved terms, and which packages are closed or hidden for the request.
    const resolver = !termsRequest ? null : this.library
      ? libraryResolver(this.library, { termsLimits: this.termsLimits, request: termsRequest })
      : stateResolver(this.states, { composition, allowUnsigned: this.allowUnsigned, termsLimits: this.termsLimits, request: termsRequest });
    const hookContext = Object.freeze({
      get request() { return Object.freeze({ ...request }); },
      library: this.library,
      structure: this.structure,
      audiences: this.audiences,
      now,
    });
    return { now, index, request, caller, loaded, hookContext, composition, findings, resolver };
  }

  #plan(ctx) {
    const { now, index, request, composition } = ctx;
    const exclude = [];
    if (!request.includeAll && this.library) {
      for (const { result } of this.library.packages) {
        for (const node of result.nodes) {
          const allExcluded = node.representations.every((rep) => !passesDefaultPolicy(citationFor(result, node, rep, { now, index })));
          if (allExcluded) exclude.push({ digest: result.digest, node: `${result.manifest.id}#${node.path}` });
        }
      }
    }
    // Contract §9.2 step 5.4 and §9.5: the locale chooses among the representations steps 5.1 to 5.3 keep, which a
    // backend cannot see; so when a node's representations differ there, locale is applied only in the gate.
    const localeHeld = Boolean(request.locale) && this.library !== null && this.library.packages.some(({ result }) =>
      result.nodes.some((node) => node.representations.length > 1 && new Set(node.representations.map(this.#eligibleIn(ctx, result, node))).size > 1));
    const concepts = this.#concepts(request);
    const filters = {
      digests: this.library ? this.library.packages.map((p) => p.result.digest) : [...this.allowed],
      exclude,
      ...(this.audiences ? { audiences: this.audiences, allowUnlabelled: this.allowUnlabelled } : {}),
      ...(request.locale && !localeHeld ? { locale: request.locale } : {}),
      // Contract §9.5: a locale held back for the gate means the backend keeps every representation of a node, so
      // the one the gate chooses is never dropped for a better-scoring file the gate removes.
      ...(localeHeld ? { everyRepresentation: true } : {}),
      // Contract §9.5: a record bound by composition carries none of those concepts itself, so the filter is left
      // to the gate when any loaded package binds members.
      ...(concepts && !composition.hasBindings ? { concepts } : {}),
    };
    // A Reader-internal candidate check for what has no pushdown filter: upTo, and concepts bound by composition.
    // Backends that know it (the Reader's own) apply it after scoring; the gate still checks every candidate.
    const accept = this.#accept(ctx, concepts);
    if (accept) filters.accept = accept;
    // Ask for more than the limit when the gate may drop hits (no pushdown, or a filter with no pushdown), or when
    // an egress hook reorders them and needs candidates to choose from. Either way the search asks again while too
    // few pass (contract §9.2).
    const pushdown = this.backend.features?.includes('filterPushdown');
    const first = pushdown && !localeHeld && !this.hooks.egress && typeof request.upTo !== 'string' && !request.terms && !(concepts && composition.hasBindings) ? request.limit : request.limit * this.overfetch;
    return { limit: Math.max(1, this.maxCandidates ? Math.min(first, this.maxCandidates) : first), filters };
  }

  /**
   * The candidate check for upTo and for concepts bound by composition, on a hit before it is resolved: the gate's
   * own tests (steps 5.5 and 5.6) on the node's package, path and concepts. Library searches only.
   */
  #accept({ caller, loaded, composition }, concepts) {
    if (!this.library) return null;
    const upTo = typeof caller.upTo === 'string' ? caller.upTo : null;
    const composed = concepts && composition.hasBindings ? new Set(concepts) : null;
    if (!upTo && !composed) return null;
    const beyond = new Map();
    const paths = new Map();
    return (hit) => {
      const result = loaded.get(hit?.digest);
      if (!result) return true;
      let byPath = paths.get(result.digest);
      if (!byPath) paths.set(result.digest, (byPath = new Map(result.nodes.map((n) => [n.path, n]))));
      const rep = byPath.get(hit.path)?.representations.find((r) => (r.locale ?? null) === (hit.locale ?? null));
      if (!rep) return true;
      const record = { package: { digest: result.digest, id: result.manifest.id }, node: { path: hit.path }, concepts: rep.concepts ?? [] };
      if (composed && !composition.boundTo(record, composed)) return false;
      return !upTo || this.#passesUpTo(record, upTo, loaded, composition, beyond);
    };
  }

  /** The concepts a record must be bound to: the caller's, plus a scope and its descendants. */
  #concepts(request) {
    const set = new Set(request.concepts ?? []);
    if (request.scope) {
      set.add(request.scope);
      for (const c of this.structure?.descendants(request.scope) ?? []) set.add(c);
    }
    return set.size > 0 ? [...set] : undefined;
  }

  /**
   * Contract §9.2, "Ingress narrowing": concepts or a scope an ingress hook set keep only records bound to them, by
   * their own concepts or by composition, after the backend and before the egress hook and the gate, on every round.
   * A backend with pushdown has already applied them where it could; this covers composition and backends without.
   */
  #narrow(candidates, ctx) {
    const { request, caller } = ctx;
    if (request.concepts === caller.concepts && request.scope === caller.scope) return candidates;
    const concepts = this.#concepts(request);
    if (!concepts) return candidates;
    const wanted = new Set(concepts);
    return candidates.filter((r) => ctx.composition.boundTo(r, wanted));
  }

  /** Turns backend hits into citation records; hits that do not resolve are dropped. */
  #resolve(hits, ctx) {
    const { now, index, loaded } = ctx;
    // Counted afresh each round, as the terms gate's are: the last round's count is the one reported.
    ctx.withheld = 0;
    const out = [];
    for (const hit of Array.isArray(hits) ? hits : []) {
      if (hit?.record) {
        // Contract §9.4: a record whose own package's state is missing is withheld, and counted.
        if (!this.library && this.missing.length > 0 && this.allowed.has(hit.digest) && !this.states.has(hit.digest)) {
          ctx.withheld++;
          continue;
        }
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

  /** The gate: always last, whatever the backend and the hooks did. Every record that passes, best first; the caller keeps `limit`. */
  #gate(candidates, ctx) {
    const { caller, loaded, composition } = ctx;
    // Counted afresh each round: the last round's count is the one reported.
    ctx.termsExcluded = caller.terms ? new TermsCount() : null;
    const request = caller;
    const concepts = this.#concepts(caller);
    const wanted = concepts ? new Set(concepts) : null;
    const beyond = new Map();
    const allowed = this.library ? new Set(loaded.keys()) : this.allowed;
    const seen = new Set();
    const out = [];
    for (const record of Array.isArray(candidates) ? candidates : []) {
      if (!record?.package || !record?.node || !record?.trust) continue;
      if (!allowed.has(record.package.digest)) continue;
      // Contract §9.4: with a state missing, a record cannot be shown to be free of what that package composes or
      // relates; without an index of the store, every record is withheld rather than returned as if unlimited.
      if (!this.library && this.missing.length > 0) {
        ctx.withheld++;
        continue;
      }
      if (!request.includeAll && !passesDefaultPolicy(record)) continue;
      if (!audienceAllowed(recordAudience(record), this.audiences, this.allowUnlabelled)) continue;
      if (request.locale && !this.#localeOk(record, request.locale, loaded, ctx)) continue;
      if (wanted && !composition.boundTo(record, wanted)) continue;
      // Contract §9.2 step 6: upTo follows the caller; an ingress hook never changes it.
      if (typeof request.upTo === 'string' && !this.#passesUpTo(record, request.upTo, loaded, composition, beyond)) continue;
      // Contract §9.2: one result per node representation and span.
      const key = `${record.node.ref}\u0000${record.node.locale ?? ''}\u0000${record.span?.start ?? ''}\u0000${record.span?.end ?? ''}`;
      if (seen.has(key)) continue;
      // Contract §9.2 step 5.3 and §15.4: with a terms request, the terms gate.
      let kept = record;
      if (request.terms) {
        const termed = this.#terms(record, request.terms, ctx.resolver, ctx.termsExcluded);
        if (!termed) continue;
        kept = termed;
      }
      seen.add(key);
      out.push(kept);
    }
    if (!this.hooks.egress) out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return out;
  }

  /**
   * Contract §15.3–15.4: the record with its resolved terms, or null when the terms gate removes it (counted by
   * reason, and as hidden when its package is hidden for the request). A package with no terms result (its manifest
   * failed its schema) has every field at its strictest. A record that passes names no hidden package in
   * supersededBy or contestedBy (§15.4, "Nothing names a hidden package").
   */
  #terms(record, request, resolver, excluded) {
    const digest = record.package.digest;
    const { pkg, composites, ai, rating } = resolver.nodeTerms(digest, record.node.path);
    const reasons = gateReasons(request, ai, rating);
    if (reasons.length > 0) {
      excluded.add(reasons, resolver.closure(digest).hidden);
      return null;
    }
    return resolver.withoutHidden({ ...record, terms: recordTerms(pkg.authority, ai, rating, resolveExport(pkg, composites)) });
  }

  /**
   * Contract §9: the record's own package limits it by the node's own concepts; each loaded package that composes it
   * and whose reading order places upTo limits it by the node's own concepts and the concepts it binds it to.
   */
  #passesUpTo(record, upTo, loaded, composition, beyond) {
    if (!passesUpTo(record, this.#readingOrder(record.package.digest, loaded), upTo)) return false;
    for (const composer of composition.composersOf(record.package.digest)) {
      // Contract §9, Members: a composer limits a member only when its signers speak for the member (as for
      // relations, R004), or the host allows unsigned packages to.
      if (!this.allowUnsigned && !scopeCovers(this.#relationScopes(composer.digest, loaded), record.package.id)) continue;
      // It limits by the node's own concepts, and by the concepts it binds it to: none of them, or their ancestors,
      // may come after upTo.
      let late = beyond.get(composer.digest);
      if (late === undefined) {
        const order = this.#readingOrder(composer.digest, loaded);
        late = order?.positions.has(upTo) ? { order, set: lateConcepts(order, upTo) } : null;
        beyond.set(composer.digest, late);
      }
      if (!late) continue;
      if (!passesUpTo(record, late.order, upTo) || composer.binds(record, late.set)) return false;
    }
    return true;
  }

  #relationScopes(digest, loaded) {
    const scopes = this.library ? loaded.get(digest)?.relationScopes : this.states.get(digest)?.relationScopes;
    return Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string') : [];
  }

  #readingOrder(digest, loaded) {
    if (this.library) {
      const result = loaded.get(digest);
      return result ? readingOrderOf(result) : null;
    }
    return readingOrderFromState(this.states.get(digest)?.readingOrder);
  }

  #localeOk(record, locale, loaded, ctx) {
    const result = loaded.get(record.package.digest);
    const node = result?.nodes.find((n) => n.path === record.node.path);
    if (!node) return this.#storedLocaleOk(record, locale, ctx);
    // Contract §9.2 step 5.4: chosen among the representations that pass steps 5.1 to 5.3, so a retired
    // translation falls back as a missing one does.
    const rep = pickRepresentation(node, locale, this.#eligibleIn(ctx, result, node));
    if (!rep) return false;
    return (representationTag(node, rep) ?? null) === (record.node.locale ?? null);
  }

  /**
   * Contract §9.4: a store record's node comes from its package state, which lists the files of each node with more
   * than one, so a store search chooses one per node as a library does. A node the state does not list has one
   * file, which the lookup chooses or falls back to. A state from before 0.8.0 lists none: a record then passes
   * when its own language matches the request, as in 0.7.0.
   */
  #storedLocaleOk(record, locale, ctx) {
    const state = this.states?.get(record.package.digest);
    if (!state || typeof state.representations !== 'object' || state.representations === null) return localeMatches(record.node.locale, locale);
    const node = storedNode(state, record.node.path);
    if (!node) return true;
    // Contract §9.2 step 5.4: among the files that pass steps 5.1 to 5.3, as in a library search.
    const kept = { now: ctx.now, superseded: record.trust.superseded === true, includeAll: ctx.caller.includeAll, audiences: this.audiences, allowUnlabelled: this.allowUnlabelled, audienceAllowed };
    const rep = pickRepresentation(node, locale, (f) => storedFileKept(f, kept));
    return rep !== undefined && (representationTag(node, rep) ?? null) === (record.node.locale ?? null);
  }

  /**
   * Contract §9.2 steps 5.2 and 5.3, per representation: whether the default retrieval policy (unless the host opted
   * in) and the audience set keep it. Cached for the search call. The terms gate is per node, so it never tells two
   * representations apart.
   */
  #eligibleIn(ctx, result, node) {
    ctx.eligible ??= new Map();
    const key = `${result.digest}\u0000${node.path}`;
    let byRep = ctx.eligible.get(key);
    if (!byRep) {
      byRep = new Map(node.representations.map((rep) => {
        const record = citationFor(result, node, rep, { now: ctx.now, index: ctx.index });
        const kept = (ctx.caller.includeAll || passesDefaultPolicy(record)) && audienceAllowed(recordAudience(record), this.audiences, this.allowUnlabelled);
        return [rep, kept];
      }));
      ctx.eligible.set(key, byRep);
    }
    return (rep) => byRep.get(rep) === true;
  }
}

/** The concepts a reading order places after upTo (contract §9). */
function lateConcepts(order, upTo) {
  const limit = order.positions.get(upTo);
  return new Set([...order.positions].filter(([, n]) => n > limit).map(([c]) => c));
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
