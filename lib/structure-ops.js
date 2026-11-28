// Structure operations: spec/moca-reader-contract.md §10.
//
// Lookups over the merged structure of every loaded package plus the host's
// overlays (moca-spec ADR-0008). They are facts, so every Reader answers them
// identically; each result says which layer stated it.
import { StructureGraph, preferred } from './structure.js';
import { citationFor, passesDefaultPolicy, pickRepresentation } from './citation.js';
import { compositionOf, CompositionIndex } from './composition.js';
import { chooseEdition, compareSemver } from './editions.js';
import { fileSummary, packageInForce, summaryPasses } from './availability.js';

const byIri = (a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0);

export class StructureIndex {
  /**
   * @param {import('./library.js').Library} library
   * @param {import('./structure.js').Fact[]} overlayFacts
   * @param {Array<{ result: object }>} [packages]  the loaded packages whose structure is merged: every one, or, under
   *   a terms request, those not closed for it (contract §10, "Under a terms request")
   */
  constructor(library, overlayFacts = [], packages = library.packages) {
    this.library = library;
    this.packages = packages;
    const facts = packages.flatMap(({ result }) => result.structure?.facts ?? []);
    this.graph = new StructureGraph([...facts, ...overlayFacts]);
  }

  #item(iri, at) {
    const c = this.graph.concepts.get(iri);
    const label = c ? preferred(c.labels) : undefined;
    return { iri, ...(label !== undefined ? { label } : {}), layer: at.layer };
  }

  /** A concept, or null when no layer declares it. */
  concept(iri) {
    const c = this.graph.concepts.get(iri);
    if (!c?.declared) return null;
    const label = preferred(c.labels);
    const definition = preferred(c.definitions);
    return {
      iri,
      ...(label !== undefined ? { label } : {}),
      labels: { ...c.labels },
      altLabels: Object.fromEntries(Object.entries(c.altLabels ?? {}).map(([lang, list]) => [lang, [...list]])),
      ...(definition !== undefined ? { definition } : {}),
      deprecated: c.deprecated,
      replacedBy: this.graph.in('replaces', iri).map((e) => e.iri),
      replaces: this.graph.out('replaces', iri).map((e) => e.iri),
      layer: c.declared.layer,
    };
  }

  /**
   * What `iri` requires. Transitively, in dependency order: every concept
   * comes after the concepts it requires; ties are broken by IRI.
   */
  requires(iri, { transitive = false } = {}) {
    if (!transitive) return this.graph.out('requires', iri).map((e) => this.#item(e.iri, e));
    // Depth first and iterative, so a long chain cannot exhaust the call stack:
    // each concept is emitted after the concepts it requires.
    const out = [];
    const done = new Set([iri]);
    const frames = [{ edge: null, next: this.graph.out('requires', iri), i: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.i < frame.next.length) {
        const e = frame.next[frame.i++];
        if (done.has(e.iri)) continue;
        done.add(e.iri);
        frames.push({ edge: e, next: this.graph.out('requires', e.iri), i: 0 });
      } else {
        frames.pop();
        if (frame.edge) out.push(this.#item(frame.edge.iri, frame.edge));
      }
    }
    return out;
  }

  /** What requires `iri` (direct). */
  requiredBy(iri) {
    return this.graph.in('requires', iri).map((e) => this.#item(e.iri, e));
  }

  /** Direct parts of `iri`, by IRI. */
  parts(iri) {
    return this.graph.out('hasPart', iri).map((e) => this.#item(e.iri, e));
  }

  /** Narrower concepts; transitively, breadth first (by depth, then IRI). */
  narrower(iri, { transitive = false } = {}) {
    const out = [];
    const seen = new Set([iri]);
    let level = [iri];
    while (level.length > 0) {
      const next = [];
      for (const n of level) {
        for (const e of this.graph.in('broader', n)) {
          if (seen.has(e.iri)) continue;
          seen.add(e.iri);
          next.push(this.#item(e.iri, e));
        }
      }
      next.sort(byIri);
      for (const x of next) out.push(x);
      if (!transitive) break;
      level = next.map((x) => x.iri);
    }
    return out;
  }

  /** Broader concepts (direct). */
  broader(iri) {
    return this.graph.out('broader', iri).map((e) => this.#item(e.iri, e));
  }

  /** Related concepts, in both directions. */
  related(iri) {
    const seen = new Map();
    for (const e of [...this.graph.out('related', iri), ...this.graph.in('related', iri)]) if (!seen.has(e.iri)) seen.set(e.iri, e);
    return [...seen.values()].sort(byIri).map((e) => this.#item(e.iri, e));
  }

  /** The members of an ordered collection, in order, or null. */
  sequence(iri) {
    const c = this.graph.collections.get(iri);
    if (!c) return null;
    return c.members.map((m) => this.#item(m, c));
  }

  /**
   * Package spec §7.4, "Display": the composite that answers for the slot `iri`, with its editions. Only a composite
   * whose `id` the IRI starts with declares it; of several loaded versions, the one in force and not superseded, then
   * the highest version, then the lowest digest.
   */
  #slot(iri) {
    const index = this.library.relationIndex();
    const now = this.library.clock();
    const live = (r) => packageInForce(r.manifest.validFrom, r.manifest.validUntil, now) && (index.superseded.get(`${r.manifest.id}@${r.manifest.version}`) ?? []).length === 0;
    const declaring = this.packages.map(({ result }) => result).filter((r) => r.structure?.slots?.some((sl) => sl.iri === iri));
    if (declaring.length === 0) return null;
    const result = declaring.sort((a, b) => (live(b) - live(a)) || compareSemver(b.manifest.version, a.manifest.version) || (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0))[0];
    const slot = result.structure.slots.find((sl) => sl.iri === iri);
    const available = new Map();
    for (const m of result.members ?? []) {
      const child = m.result;
      if (m.status !== 'resolved' || !child?.valid || !slot.editions.includes(child.manifest.id) || available.has(child.manifest.id)) continue;
      available.set(child.manifest.id, { language: typeof child.manifest.language === 'string' && child.manifest.language !== '' ? child.manifest.language : undefined, result: child });
    }
    return { slot, available, index, now };
  }

  /** Contract §10: the editions of a slot that can be chosen, ordered by id. */
  editions(iri) {
    const found = this.#slot(iri);
    if (!found) return [];
    const { slot, available } = found;
    return [...available.keys()].sort().map((id) => {
      const { language, result } = available.get(id);
      return {
        id,
        version: result.manifest.version,
        ...(language ? { language } : {}),
        ...(typeof result.manifest.title === 'string' ? { title: result.manifest.title } : {}),
        default: slot.default === id,
      };
    });
  }

  /** Contract §10: the id of the edition a search with this locale keeps, or null. */
  chooseEdition(iri, locale) {
    const found = this.#slot(iri);
    if (!found) return null;
    // Package spec §7.4, "Choosing": as a search with no audience set, only editions with a record that passes the
    // default retrieval policy.
    const { slot, index, now } = found;
    const loaded = new Set(this.library.packages.map(({ result }) => result.digest));
    const returns = (r) => loaded.has(r.digest) && summaryPasses(fileSummary(r), { now, superseded: (index.superseded.get(`${r.manifest.id}@${r.manifest.version}`) ?? []).length > 0, includeAll: false });
    const available = new Map([...found.available].filter(([, e]) => returns(e.result)));
    return chooseEdition(slot, available, locale) ?? null;
  }

  /** Every concept below `iri` by hierarchy or parts, transitively. */
  descendants(iri) {
    const out = new Set();
    const stack = [iri];
    while (stack.length > 0) {
      const n = stack.pop();
      for (const e of [...this.graph.in('broader', n), ...this.graph.out('hasPart', n), ...this.graph.out('workExample', n)]) {
        if (!out.has(e.iri) && e.iri !== iri) {
          out.add(e.iri);
          stack.push(e.iri);
        }
      }
    }
    return [...out].sort();
  }

  /**
   * Citation records of the nodes bound to `iri`, by their own concepts or by composition, optionally including those
   * bound to its narrower concepts or parts. The default retrieval policy
   * applies unless includeAll is set. Sorted by node reference.
   */
  nodes(iri, { include = 'none', locale, includeAll = false } = {}) {
    const wanted = new Set([iri]);
    if (include !== 'none') {
      const stack = [iri];
      while (stack.length > 0) {
        const n = stack.pop();
        const next = [
          ...(include === 'narrower' || include === 'both' ? this.graph.in('broader', n) : []),
          ...(include === 'parts' || include === 'both' ? [...this.graph.out('hasPart', n), ...this.graph.out('workExample', n)] : []),
        ];
        for (const e of next) if (!wanted.has(e.iri)) { wanted.add(e.iri); stack.push(e.iri); }
      }
    }
    // Package spec §5.6: a record is bound by its node's own concepts and by composition, as for search.
    const composition = new CompositionIndex(this.packages.map(({ result }) => ({ digest: result.digest, composition: compositionOf(result) })));
    return this.#citations(locale)
      .filter((r) => composition.boundTo(r, wanted))
      .filter((r) => includeAll || passesDefaultPolicy(r))
      .sort((a, b) => (a.node.ref < b.node.ref ? -1 : 1));
  }

  /** Every node's citation record from this structure's packages, with its text, as Library.citations gives it. */
  #citations(locale) {
    if (this.packages === this.library.packages) return this.library.citations({ locale, includeText: true });
    const index = this.library.relationIndex();
    const now = this.library.clock();
    return this.packages.flatMap(({ result }) => result.nodes.map((node) => {
      const rep = pickRepresentation(node, locale);
      return citationFor(result, node, rep, { now, index, text: rep.body });
    }));
  }
}
