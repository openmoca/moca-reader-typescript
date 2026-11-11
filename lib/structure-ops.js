// Structure operations: spec/moca-reader-contract.md §10.
//
// Lookups over the merged structure of every loaded package plus the host's
// overlays (moca-spec ADR-0008). They are facts, so every Reader answers them
// identically; each result says which layer stated it.
import { StructureGraph, preferred } from './structure.js';
import { passesDefaultPolicy } from './citation.js';

const byIri = (a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0);

export class StructureIndex {
  /**
   * @param {import('./library.js').Library} library
   * @param {import('./structure.js').Fact[]} overlayFacts
   */
  constructor(library, overlayFacts = []) {
    this.library = library;
    const facts = library.packages.flatMap(({ result }) => result.structure?.facts ?? []);
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
      out.push(...next);
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

  /** Every concept below `iri` by hierarchy or parts, transitively. */
  descendants(iri) {
    const out = new Set();
    const stack = [iri];
    while (stack.length > 0) {
      const n = stack.pop();
      for (const e of [...this.graph.in('broader', n), ...this.graph.out('hasPart', n)]) {
        if (!out.has(e.iri) && e.iri !== iri) {
          out.add(e.iri);
          stack.push(e.iri);
        }
      }
    }
    return [...out].sort();
  }

  /**
   * Citation records of the nodes bound to `iri`, optionally including those
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
          ...(include === 'parts' || include === 'both' ? this.graph.out('hasPart', n) : []),
        ];
        for (const e of next) if (!wanted.has(e.iri)) { wanted.add(e.iri); stack.push(e.iri); }
      }
    }
    return this.library.citations({ locale, includeText: true })
      .filter((r) => (r.concepts ?? []).some((c) => wanted.has(c)))
      .filter((r) => includeAll || passesDefaultPolicy(r))
      .sort((a, b) => (a.node.ref < b.node.ref ? -1 : 1));
  }
}
