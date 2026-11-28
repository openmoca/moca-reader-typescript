// The structure core: spec/moca-package-spec.md §5.6 and moca-spec ADR-0007.
//
// structure.ttl holds a package's concepts and how they relate, using only
// SKOS and DCMI terms. This module parses it (and overlays, moca-spec ADR-0008) into
// facts, checks node bindings, and builds a sorted JSON view of it (structureView).
// Nothing is fetched: owl:imports and non-absolute IRIs are reported, never
// followed.
import { sourceOf } from './inherit.js';
import { MOCA_DEFAULT_EDITION, readSlots, SCHEMA_WORK_EXAMPLE } from './editions.js';
import { Lexer, Parser } from 'n3';

export const STRUCTURE_FILE = 'structure.ttl';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCT = 'http://purl.org/dc/terms/';
const OWL = 'http://www.w3.org/2002/07/owl#';
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

/** Core predicates, normalised to one direction. [kind, flip] */
const PREDICATES = new Map([
  [`${SKOS}prefLabel`, ['label', false]],
  [`${SKOS}altLabel`, ['altLabel', false]],
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
  // Package spec §7.4: edition groups.
  [SCHEMA_WORK_EXAMPLE, ['workExample', false]],
  [MOCA_DEFAULT_EDITION, ['defaultEdition', false]],
]);
const RELATIONS = ['broader', 'related', 'hasPart', 'requires', 'replaces', 'workExample', 'defaultEdition'];
export const LAYERS = Object.freeze(['package', 'application', 'organisation']);

/**
 * @typedef {object} Fact
 * @property {string} s
 * @property {string} kind  concept | collection | label | altLabel | definition | broader | related | hasPart | requires | replaces | deprecated | member
 * @property {string} [o]   an IRI for relations
 * @property {string} [value] a literal
 * @property {string} [lang]
 * @property {number} [index] position, for collection members
 * @property {string} layer  package | application | organisation
 * @property {string} origin package digest or overlay id
 */

// White space as ECMAScript's \s reads it, and the line terminators among it.
const isSpace = (c) =>
  c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const isLineEnd = (c) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const isAsciiLetter = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isNameChar = (c) => isAsciiLetter(c) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2e || c === 0x2d;

/** The length of `@prefix` or `PREFIX` (ASCII letters in any case) at `i`, or 0. */
function keywordAt(text, i) {
  const at = text.charCodeAt(i) === 0x40 ? 1 : 0;
  if (i + at + 6 > text.length) return 0;
  return text.slice(i + at, i + at + 6).replace(/[A-Z]/g, (c) => c.toLowerCase()) === 'prefix' ? at + 6 : 0;
}

/**
 * The prefix names a Turtle text declares: a line that starts, after white space, with `@prefix` or `PREFIX` (any
 * case), then white space (which may run over line ends), then an optional name and a colon. The empty prefix is
 * declared but has no name, so it is not listed. One pass over the text: contract §3 bounds a Reader's work by the
 * size of what it reads, so no character is looked at more than a fixed number of times, however the lines run.
 * @param {string} text
 * @param {{ steps: number }} [work] counts the characters looked at, for tests
 * @returns {string[]}
 */
export function declaredPrefixes(text, work = { steps: 0 }) {
  const names = [];
  const n = text.length;
  let i = 0;
  // True when position i is reached from the start of a line through white space alone.
  let lineStart = true;
  while (i < n) {
    if (!lineStart) {
      while (i < n && !isLineEnd(text.charCodeAt(i))) { i++; work.steps++; }
      if (i >= n) break;
      i++;
      work.steps++;
      lineStart = true;
      continue;
    }
    while (i < n && isSpace(text.charCodeAt(i))) { i++; work.steps++; }
    const keyword = keywordAt(text, i);
    work.steps++;
    if (keyword === 0) {
      lineStart = false;
      continue;
    }
    const afterKeyword = i + keyword;
    let name = afterKeyword;
    let crossesLine = false;
    for (; name < n && isSpace(text.charCodeAt(name)); name++) {
      crossesLine ||= isLineEnd(text.charCodeAt(name));
      work.steps++;
    }
    if (name === afterKeyword) {
      i = afterKeyword;
      lineStart = false;
      continue;
    }
    let colon = name;
    if (colon < n && isAsciiLetter(text.charCodeAt(colon))) {
      for (colon++; colon < n && isNameChar(text.charCodeAt(colon)); colon++) work.steps++;
    }
    if (colon < n && text.charCodeAt(colon) === 0x3a) {
      if (colon > name) names.push(text.slice(name, colon));
      i = colon + 1;
      lineStart = false;
      continue;
    }
    // No declaration here. A line that starts inside the white space after the keyword reaches `name` through white
    // space too, so the search goes on from there.
    i = name;
    lineStart = crossesLine;
  }
  return names;
}

/** Reader contract §3: the fixed nesting limit, in blank-node property lists and collections. */
export const MAX_TURTLE_NESTING = 64;

/**
 * The first token that opens a level past `max` (a `[` or `(`, each one level), as `{ line }`, or null. Iterative, so
 * the check never depends on recursion depth. A file the lexer cannot read throws, as the parser would.
 */
function nestingOver(source, max) {
  let depth = 0;
  for (const token of new Lexer({ n3: false }).tokenize(source)) {
    if (token.type === '[' || token.type === '(') {
      depth++;
      if (depth > max) return { line: token.line };
    } else if ((token.type === ']' || token.type === ')') && depth > 0) {
      depth--;
    }
  }
  return null;
}

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
  for (const name of declaredPrefixes(source)) prefixes.add(name);
  let quads;
  try {
    // Contract §3: nested at most 64 levels deep, fixed, for structure.ttl and for host overlays alike. Counted over
    // Turtle's own tokens, so a bracket inside an IRI, a string, a comment or a prefixed name never counts.
    const depth = nestingOver(source, MAX_TURTLE_NESTING);
    if (depth) {
      diagnostics.add('O001_ONTOLOGY_UNPARSEABLE', `${file} is nested more than ${MAX_TURTLE_NESTING} levels deep`, { file, ...(depth.line ? { line: depth.line } : {}) });
      return { facts, prefixes, ok: false };
    }
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
  // Contract §3: a member list is walked once, however many collections name it, and the list cells reached from
  // every skos:memberList statement, added together, stay within the triple limit.
  const walked = new Map();
  let cells = 0;
  const membersOf = (head) => {
    if (head.termType !== 'BlankNode') return [];
    if (walked.has(head.value)) return walked.get(head.value);
    const items = [];
    const seen = new Set();
    let node = head;
    let index = 0;
    for (; node && node.termType === 'BlankNode' && !seen.has(node.value); index++) {
      seen.add(node.value);
      const cell = lists.get(node.value);
      if (!cell?.first) break;
      if (cell.first.termType === 'NamedNode') items.push({ o: cell.first.value, index });
      node = cell.rest;
    }
    items.cells = index;
    walked.set(head.value, items);
    return items;
  };

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
      // A list reached again costs its cells again: a walk that starts part-way down another list is new work.
      const items = membersOf(q.object);
      cells += Math.max(items.cells ?? 0, 1);
      if (cells > limits.maxTriples) {
        diagnostics.add('O001_ONTOLOGY_UNPARSEABLE', `${file} has more than ${limits.maxTriples} collection members, counting each collection's member list in full`, { file });
        return { facts: [], prefixes, ok: false };
      }
      for (const { o, index } of items) add({ s, kind: 'member', o, index });
      continue;
    }
    const known = PREDICATES.get(q.predicate.value);
    if (!known) continue;
    const [kind, flip] = known;
    if (kind === 'label' || kind === 'altLabel' || kind === 'definition') {
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
      if (!this.concepts.has(iri)) this.concepts.set(iri, { iri, declared: null, labels: {}, altLabels: {}, definitions: {}, deprecated: false });
      return this.concepts.get(iri);
    };
    const edge = (map, s, o, fact) => {
      if (!map.has(s)) map.set(s, new Map());
      if (!map.get(s).has(o)) map.get(s).set(o, { layer: fact.layer, origin: fact.origin });
    };
    // The members each collection already has, so adding one is constant work however long the list is.
    const memberSets = new Map();
    for (const f of this.facts) {
      if (f.kind === 'concept') {
        const c = concept(f.s);
        if (!c.declared) c.declared = { layer: f.layer, origin: f.origin };
      } else if (f.kind === 'collection') {
        if (!this.collections.has(f.s)) this.collections.set(f.s, { iri: f.s, layer: f.layer, origin: f.origin, members: [] });
        this.collections.get(f.s).typed = true;
      } else if (f.kind === 'member') {
        if (!this.collections.has(f.s)) this.collections.set(f.s, { iri: f.s, layer: f.layer, origin: f.origin, members: [] });
        const c = this.collections.get(f.s);
        if (!memberSets.has(c)) memberSets.set(c, new Set());
        if (c.origin === f.origin && !memberSets.get(c).has(f.o)) {
          memberSets.get(c).add(f.o);
          c.members[f.index] = f.o;
        }
      } else if (f.kind === 'label') {
        const c = concept(f.s);
        if (!(f.lang in c.labels)) c.labels[f.lang] = f.value;
      } else if (f.kind === 'altLabel') {
        // Package spec §5.6: any number per language, in the order read, each once.
        const c = concept(f.s);
        const list = (c.altLabels[f.lang] ??= []);
        if (!list.includes(f.value)) list.push(f.value);
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
export function readStructure({ bytes, nodes, diagnostics, limits, origin, memberIds = [], ownId }) {
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
  // Package spec §5.4: a translation that writes no moca.concepts is bound as its default file is.
  for (const node of nodes) {
    for (const rep of node.representations) {
      const from = sourceOf(node, rep, 'concepts');
      if (from !== rep && from.concepts) rep.concepts = [...from.concepts];
    }
  }

  // Package spec §7.4: the composite's own edition groups.
  const slots = readSlots(graph, memberIds, diagnostics, STRUCTURE_FILE, ownId);
  // Package spec §7.4, "Problems": an ignored statement binds nothing, in this package's structure or the merged one.
  const bySlot = new Map(slots.map((sl) => [sl.iri, sl]));
  const kept = (f) => (f.kind === 'workExample' ? Boolean(bySlot.get(f.s)?.editions.includes(f.o))
    : f.kind === 'defaultEdition' ? bySlot.get(f.s)?.default === f.o : true);
  const facts = parsed.facts.every(kept) ? parsed.facts : parsed.facts.filter(kept);
  const read = facts === parsed.facts ? graph : new StructureGraph(facts);

  const ok = !diagnostics.items.slice(before).some((d) => d.code.startsWith('O'));
  return { present: true, ok, facts, graph: read, slots };
}
