// The structure core: spec/moca-package-spec.md §5.6 and moca-spec ADR-0007.
//
// structure.ttl holds a package's concepts and how they relate, using only
// SKOS and DCMI terms. This module parses it (and overlays, moca-spec ADR-0008) into
// facts, checks node bindings, and builds a sorted JSON view of it (structureView).
// Nothing is fetched: owl:imports and non-absolute IRIs are reported, never
// followed.
import { Parser } from 'n3';

export const STRUCTURE_FILE = 'structure.ttl';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCT = 'http://purl.org/dc/terms/';
const OWL = 'http://www.w3.org/2002/07/owl#';
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
const PREFIX_DECL = /^\s*(?:@prefix|PREFIX)\s+([A-Za-z][\w.-]*)?:/gim;

/** Core predicates, normalised to one direction. [kind, flip] */
const PREDICATES = new Map([
  [`${SKOS}prefLabel`, ['label', false]],
  [`${SKOS}definition`, ['definition', false]],
  [`${SKOS}broader`, ['broader', false]],
  [`${SKOS}narrower`, ['broader', true]],
  [`${SKOS}related`, ['related', false]],
  [`${DCT}hasPart`, ['hasPart', false]],
  [`${DCT}isPartOf`, ['hasPart', true]],
  [`${DCT}requires`, ['requires', false]],
  [`${DCT}isRequiredBy`, ['requires', true]],
  [`${DCT}replaces`, ['replaces', false]],
  [`${DCT}isReplacedBy`, ['replaces', true]],
  [`${OWL}deprecated`, ['deprecated', false]],
]);
const RELATIONS = ['broader', 'related', 'hasPart', 'requires', 'replaces'];
export const LAYERS = Object.freeze(['package', 'application', 'organisation']);

/**
 * @typedef {object} Fact
 * @property {string} s
 * @property {string} kind  concept | collection | label | definition | broader | related | hasPart | requires | replaces | deprecated | member
 * @property {string} [o]   an IRI for relations
 * @property {string} [value] a literal
 * @property {string} [lang]
 * @property {number} [index] position, for collection members
 * @property {string} layer  package | application | organisation
 * @property {string} origin package digest or overlay id
 */

/**
 * Parses Turtle into core facts. Unknown predicates are ignored (they are
 * vocabulary for applications, moca-spec ADR-0008); problems are reported as O codes.
 * @returns {{ facts: Fact[], prefixes: Set<string>, ok: boolean }}
 */
export function parseStructure(text, { file, layer, origin, diagnostics, limits }) {
  const before = diagnostics.items.length;
  const facts = [];
  const prefixes = new Set();
  const bytes = Buffer.isBuffer(text) ? text.length : Buffer.byteLength(text);
  if (bytes > limits.maxStructureBytes) {
    diagnostics.add('O001_ONTOLOGY_UNPARSEABLE', `${file} is larger than the ${limits.maxStructureBytes}-byte limit`, { file });
    return { facts, prefixes, ok: false };
  }
  const source = text.toString('utf8');
  for (const m of source.matchAll(PREFIX_DECL)) if (m[1]) prefixes.add(m[1]);
  let quads;
  try {
    quads = new Parser({ format: 'text/turtle' }).parse(source);
  } catch (err) {
    diagnostics.add('O001_ONTOLOGY_UNPARSEABLE', `${file} is not parseable Turtle: ${err.message}`, { file });
    return { facts, prefixes, ok: false };
  }
  if (quads.length > limits.maxTriples) {
    diagnostics.add('O001_ONTOLOGY_UNPARSEABLE', `${file} has ${quads.length} triples, over the ${limits.maxTriples} limit`, { file });
    return { facts, prefixes, ok: false };
  }

  const lists = new Map();
  for (const q of quads) {
    if (q.subject.termType === 'BlankNode' && (q.predicate.value === `${RDF}first` || q.predicate.value === `${RDF}rest`)) {
      if (!lists.has(q.subject.value)) lists.set(q.subject.value, {});
      lists.get(q.subject.value)[q.predicate.value === `${RDF}first` ? 'first' : 'rest'] = q.object;
    }
  }
  const add = (fact) => facts.push({ ...fact, layer, origin });

  for (const q of quads) {
    if (q.predicate.value === `${OWL}imports`) {
      diagnostics.add('O003_REMOTE_REFERENCE', `owl:imports ${q.object.value} is not allowed; structure must be self-contained`, { file });
    }
    for (const term of [q.subject, q.predicate, q.object]) {
      if (term.termType === 'NamedNode' && !ABSOLUTE_IRI.test(term.value)) {
        diagnostics.add('O003_REMOTE_REFERENCE', `IRI <${term.value}> is not absolute`, { file });
      }
    }
    if (q.subject.termType !== 'NamedNode') continue;
    const s = q.subject.value;
    if (q.predicate.value === `${RDF}type`) {
      if (q.object.value === `${SKOS}Concept`) add({ s, kind: 'concept' });
      if (q.object.value === `${SKOS}OrderedCollection`) add({ s, kind: 'collection' });
      continue;
    }
    if (q.predicate.value === `${SKOS}memberList`) {
      let node = q.object;
      const seen = new Set();
      for (let index = 0; node && node.termType === 'BlankNode' && !seen.has(node.value); index++) {
        seen.add(node.value);
        const cell = lists.get(node.value);
        if (!cell?.first) break;
        if (cell.first.termType === 'NamedNode') add({ s, kind: 'member', o: cell.first.value, index });
        node = cell.rest;
      }
      continue;
    }
    const known = PREDICATES.get(q.predicate.value);
    if (!known) continue;
    const [kind, flip] = known;
    if (kind === 'label' || kind === 'definition') {
      if (q.object.termType === 'Literal') add({ s, kind, value: q.object.value, lang: q.object.language || '' });
    } else if (kind === 'deprecated') {
      if (q.object.termType === 'Literal' && q.object.value === 'true') add({ s, kind });
    } else if (q.object.termType === 'NamedNode') {
      add(flip ? { s: q.object.value, kind, o: s } : { s, kind, o: q.object.value });
    }
  }
  return { facts, prefixes, ok: !diagnostics.items.slice(before).some((d) => d.code.startsWith('O')) };
}

/**
 * An index over facts from any number of layers. The first layer to state a
 * fact (package, then application, then organisation) is the one reported.
 */
export class StructureGraph {
  /** @param {Fact[]} facts */
  constructor(facts) {
    const rank = (f) => LAYERS.indexOf(f.layer);
    this.facts = [...facts].sort((a, b) => rank(a) - rank(b));
    this.concepts = new Map();
    this.collections = new Map();
    this.edges = Object.fromEntries(RELATIONS.map((k) => [k, new Map()]));
    this.inverse = Object.fromEntries(RELATIONS.map((k) => [k, new Map()]));
    const concept = (iri) => {
      if (!this.concepts.has(iri)) this.concepts.set(iri, { iri, declared: null, labels: {}, definitions: {}, deprecated: false });
      return this.concepts.get(iri);
    };
    const edge = (map, s, o, fact) => {
      if (!map.has(s)) map.set(s, new Map());
      if (!map.get(s).has(o)) map.get(s).set(o, { layer: fact.layer, origin: fact.origin });
    };
    for (const f of this.facts) {
      if (f.kind === 'concept') {
        const c = concept(f.s);
        if (!c.declared) c.declared = { layer: f.layer, origin: f.origin };
      } else if (f.kind === 'collection') {
        if (!this.collections.has(f.s)) this.collections.set(f.s, { iri: f.s, layer: f.layer, origin: f.origin, members: [] });
      } else if (f.kind === 'member') {
        if (!this.collections.has(f.s)) this.collections.set(f.s, { iri: f.s, layer: f.layer, origin: f.origin, members: [] });
        const c = this.collections.get(f.s);
        if (c.origin === f.origin && !c.members.includes(f.o)) c.members[f.index] = f.o;
      } else if (f.kind === 'label') {
        const c = concept(f.s);
        if (!(f.lang in c.labels)) c.labels[f.lang] = f.value;
      } else if (f.kind === 'definition') {
        const c = concept(f.s);
        if (!(f.lang in c.definitions)) c.definitions[f.lang] = f.value;
      } else if (f.kind === 'deprecated') {
        concept(f.s).deprecated = true;
      } else if (RELATIONS.includes(f.kind)) {
        edge(this.edges[f.kind], f.s, f.o, f);
        edge(this.inverse[f.kind], f.o, f.s, f);
      }
    }
    for (const c of this.collections.values()) c.members = c.members.filter(Boolean);
  }

  /** IRIs a relation points to from `iri`, sorted, with the layer that stated each. */
  out(kind, iri) {
    return [...(this.edges[kind].get(iri) ?? new Map())].map(([o, at]) => ({ iri: o, ...at })).sort((a, b) => (a.iri < b.iri ? -1 : 1));
  }

  in(kind, iri) {
    return [...(this.inverse[kind].get(iri) ?? new Map())].map(([s, at]) => ({ iri: s, ...at })).sort((a, b) => (a.iri < b.iri ? -1 : 1));
  }

  isDeclared(iri) {
    return Boolean(this.concepts.get(iri)?.declared) || this.collections.has(iri);
  }

  /**
   * The first cycle found in a relation, as a list of IRIs, or null. Iterative,
   * so a long chain cannot exhaust the call stack.
   */
  cycle(kind) {
    const state = new Map();
    const path = [];
    for (const start of [...this.edges[kind].keys()].sort()) {
      if (state.has(start)) continue;
      const frames = [{ n: start, next: this.out(kind, start), i: 0 }];
      state.set(start, 1);
      path.push(start);
      while (frames.length > 0) {
        const frame = frames[frames.length - 1];
        if (frame.i < frame.next.length) {
          const { iri } = frame.next[frame.i++];
          if (state.get(iri) === 1) return [...path.slice(path.indexOf(iri)), iri];
          if (!state.has(iri)) {
            state.set(iri, 1);
            path.push(iri);
            frames.push({ n: iri, next: this.out(kind, iri), i: 0 });
          }
        } else {
          frames.pop();
          path.pop();
          state.set(frame.n, 2);
        }
      }
    }
    return null;
  }
}

/** Preferred label: no language tag, then `en`, then the first language in order. */
export function preferred(map) {
  if ('' in map) return map[''];
  if ('en' in map) return map.en;
  const langs = Object.keys(map).sort();
  return langs.length > 0 ? map[langs[0]] : undefined;
}

/** A JSON view of the structure, sorted so any two Readers produce the same bytes. Not a package file (moca-spec ADR-0019). */
export function structureView(graph) {
  const concepts = [...graph.concepts.values()].filter((c) => c.declared).sort((a, b) => (a.iri < b.iri ? -1 : 1)).map((c) => {
    const label = preferred(c.labels);
    const definition = preferred(c.definitions);
    const ids = (kind) => graph.out(kind, c.iri).map((e) => e.iri);
    return {
      iri: c.iri,
      ...(label !== undefined ? { label } : {}),
      ...(definition !== undefined ? { definition } : {}),
      ...(c.deprecated ? { deprecated: true } : {}),
      broader: ids('broader'),
      related: [...new Set([...ids('related'), ...graph.in('related', c.iri).map((e) => e.iri)])].sort(),
      parts: ids('hasPart'),
      requires: ids('requires'),
      replaces: ids('replaces'),
    };
  });
  const sequences = [...graph.collections.values()].sort((a, b) => (a.iri < b.iri ? -1 : 1)).map((c) => ({ iri: c.iri, members: [...c.members] }));
  return { structureVersion: 1, concepts, sequences };
}

/**
 * Reads a package's structure: parses structure.ttl, checks node bindings,
 * and sets rep.concepts.
 * @returns {{ present: boolean, ok: boolean, facts: Fact[], graph: StructureGraph|null } }
 */
export function readStructure({ bytes, nodes, diagnostics, limits, origin }) {
  const ttl = bytes.get(STRUCTURE_FILE);
  const bound = nodes.flatMap((n) => n.representations).filter((r) => Array.isArray(r.frontmatter.moca?.concepts));
  if (!ttl && bound.length === 0) return { present: false, ok: false, facts: [], graph: null };
  const before = diagnostics.items.length;

  if (!ttl) {
    for (const rep of bound) diagnostics.add('O002_CONCEPT_UNDECLARED', `concepts are bound but the package has no ${STRUCTURE_FILE}`, { file: rep.file });
    return { present: false, ok: false, facts: [], graph: null };
  }

  const parsed = parseStructure(ttl, { file: STRUCTURE_FILE, layer: 'package', origin, diagnostics, limits });
  const graph = new StructureGraph(parsed.facts);
  for (const [kind, name] of [['requires', 'requires'], ['broader', 'broader'], ['hasPart', 'hasPart']]) {
    const loop = graph.cycle(kind);
    if (loop) diagnostics.add('O005_STRUCTURE_CYCLE', `${name} forms a cycle: ${loop.join(' -> ')}`, { file: STRUCTURE_FILE });
  }
  const referenced = new Set();
  for (const kind of RELATIONS) for (const [s, targets] of graph.edges[kind]) { referenced.add(s); for (const o of targets.keys()) referenced.add(o); }
  for (const c of graph.collections.values()) for (const m of c.members) referenced.add(m);
  for (const iri of [...referenced].sort()) {
    if (!graph.isDeclared(iri)) diagnostics.add('O002_CONCEPT_UNDECLARED', `${iri} is used in a relation but not declared as a skos:Concept`, { file: STRUCTURE_FILE });
  }

  for (const rep of bound) {
    const concepts = [];
    for (const b of rep.frontmatter.moca.concepts) {
      const iri = b?.iri;
      if (typeof iri !== 'string' || !ABSOLUTE_IRI.test(iri)) {
        diagnostics.add('O003_REMOTE_REFERENCE', `concept "${iri}" is not an absolute IRI`, { file: rep.file });
        continue;
      }
      if (parsed.prefixes.has(iri.slice(0, iri.indexOf(':'))) && !graph.isDeclared(iri)) {
        diagnostics.add('O003_REMOTE_REFERENCE', `concept "${iri}" is a prefixed name; write the absolute IRI`, { file: rep.file });
        continue;
      }
      if (!graph.isDeclared(iri)) diagnostics.add('O002_CONCEPT_UNDECLARED', `concept ${iri} is not declared in ${STRUCTURE_FILE}`, { file: rep.file });
      concepts.push(iri);
    }
    if (concepts.length > 0) rep.concepts = [...new Set(concepts)];
  }

  const ok = !diagnostics.items.slice(before).some((d) => d.code.startsWith('O'));
  return { present: true, ok, facts: parsed.facts, graph };
}
