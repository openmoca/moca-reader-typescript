// Package spec §5.6 and Reader contract §9: binding by composition. A composing package's own structure may use a
// member's package id (at any depth) or a member's node identifier as a concept; the member's records are then bound
// to it, and to every concept that has it as a descendant, for the concepts and scope filters and for upTo.

/** Plain JSON safe for any key, "__proto__" included. */
function record(entries) {
  const out = {};
  for (const [k, v] of entries) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

/** The concept and every concept that has it as a descendant, by broader or hasPart, in one graph. */
function withAncestors(graph, iri) {
  const out = new Set([iri]);
  const stack = [iri];
  while (stack.length > 0) {
    const n = stack.pop();
    for (const e of [...graph.out('broader', n), ...graph.in('hasPart', n)]) {
      if (!out.has(e.iri)) {
        out.add(e.iri);
        stack.push(e.iri);
      }
    }
  }
  return out;
}

const bindings = new WeakMap();

/**
 * What a composing package's own structure binds its resolved members to: one entry per member digest, with the
 * concepts every record of that member is bound to, and the concepts each node path is bound to. Only members that
 * resolved and matched their pin, and are valid, are bound.
 * @param {object} result  a package result from readPackage
 * @returns {{ digest: string, concepts: string[], nodes: Record<string, string[]> }[]}
 */
export function compositionOf(result) {
  if (bindings.has(result)) return bindings.get(result);
  const graph = result?.structure?.graph ?? null;
  const declared = (iri) => Boolean(graph?.concepts.get(iri)?.declared);
  const byDigest = new Map();
  const visit = (members, chain, seen) => {
    for (const m of members ?? []) {
      const child = m.result;
      if (m.status !== 'resolved' || !child?.valid || !child.digest || seen.has(child.digest)) continue;
      const ids = [...chain, child.manifest.id];
      if (graph) {
        const entry = byDigest.get(child.digest) ?? { concepts: new Set(), nodes: new Map() };
        for (const id of ids) if (declared(id)) for (const c of withAncestors(graph, id)) entry.concepts.add(c);
        for (const node of child.nodes) {
          const nodeId = `${child.manifest.id}#${node.path}`;
          if (!declared(nodeId)) continue;
          const set = entry.nodes.get(node.path) ?? new Set();
          for (const c of withAncestors(graph, nodeId)) set.add(c);
          entry.nodes.set(node.path, set);
        }
        byDigest.set(child.digest, entry);
      }
      visit(child.members, ids, new Set([...seen, child.digest]));
    }
  };
  visit(result?.members, [], new Set([result?.digest]));
  const out = [...byDigest]
    .filter(([, e]) => e.concepts.size > 0 || e.nodes.size > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([digest, e]) => ({
      digest,
      concepts: [...e.concepts].sort(),
      nodes: record([...e.nodes].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, s]) => [p, [...s].sort()])),
    }));
  if (result && typeof result === 'object') bindings.set(result, out);
  return out;
}

/**
 * An index from member digest to the bindings each loaded composing package gives it.
 * @param {{ digest: string, composition?: unknown }[]} composers  results or package states
 */
export function compositionIndex(composers) {
  const index = new Map();
  for (const c of composers) {
    if (!Array.isArray(c?.composition)) continue;
    for (const e of c.composition) {
      if (typeof e?.digest !== 'string' || !Array.isArray(e.concepts)) continue;
      const nodes = e.nodes && typeof e.nodes === 'object' ? e.nodes : {};
      if (!index.has(e.digest)) index.set(e.digest, []);
      index.get(e.digest).push({ composer: c.digest, concepts: e.concepts.filter((x) => typeof x === 'string'), nodes });
    }
  }
  return index;
}

/** The concepts one composing package binds a record to. */
export function composedConcepts(entry, rec) {
  const path = rec?.node?.path;
  const own = typeof path === 'string' && Object.hasOwn(entry.nodes, path) && Array.isArray(entry.nodes[path]) ? entry.nodes[path] : [];
  return [...entry.concepts, ...own.filter((x) => typeof x === 'string')];
}

/** A record's concepts for the concepts and scope filters: its node's own, and every binding by composition. */
export function boundConcepts(rec, index) {
  const set = new Set(rec.concepts ?? []);
  for (const e of index.get(rec.package?.digest) ?? []) for (const c of composedConcepts(e, rec)) set.add(c);
  return [...set];
}
