// Package spec §4.10 and Reader contract §9: the reading order, and the search option upTo.

/**
 * The reading order a manifest names, resolved against the package's own structure graph; null when it does not
 * resolve (M014). A concept's position is the index of the first member that is the concept, or has it as a
 * descendant by narrower or hasPart.
 * @param {import('./structure.js').StructureGraph|null} graph  the package's own graph, never an overlay
 * @param {string} iri
 * @returns {{ iri: string, members: string[], positions: Map<string, number> }|null}
 */
export function resolveReadingOrder(graph, iri) {
  const collection = graph?.collections.get(iri);
  if (!collection?.typed || collection.members.length === 0) return null;
  // Contract §3: one walk in list order, with one visited set. A concept first reached from member i keeps i, as it
  // would if each member were walked on its own, and nothing is walked twice.
  const positions = new Map();
  collection.members.forEach((member, i) => {
    const stack = [member];
    while (stack.length > 0) {
      const n = stack.pop();
      if (positions.has(n)) continue;
      positions.set(n, i);
      // Package spec §7.4: an edition takes its slot's place, as a part does.
      for (const e of [...graph.in('broader', n), ...graph.out('hasPart', n), ...graph.out('workExample', n)]) if (!positions.has(e.iri)) stack.push(e.iri);
    }
  });
  return { iri, members: [...collection.members], positions };
}

/** The reading order as plain JSON, for a package state (contract §9.4): positions keyed by concept IRI. */
export function readingOrderState(order) {
  const positions = {};
  // An own property for every key, so "__proto__" stays data.
  for (const [iri, n] of [...order.positions].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    Object.defineProperty(positions, iri, { value: n, enumerable: true, writable: true, configurable: true });
  }
  return { iri: order.iri, members: [...order.members], positions };
}

/** A reading order from a package state, as resolveReadingOrder returns it. */
export function readingOrderFromState(state) {
  if (!state || !Array.isArray(state.members) || !state.positions || typeof state.positions !== 'object') return null;
  return { iri: state.iri, members: state.members, positions: new Map(Object.entries(state.positions)) };
}

/**
 * Contract §9: whether a record passes upTo, given its package's reading order (or null). upTo is placed as any
 * concept is, so a descendant limits as the first member that contains it. A package whose reading order does not
 * place upTo is not limited, nor is a record bound to no concept on it.
 */
export function passesUpTo(record, order, upTo) {
  if (!order || !order.positions.has(upTo)) return true;
  const limit = order.positions.get(upTo);
  return (record.concepts ?? []).every((c) => !order.positions.has(c) || order.positions.get(c) <= limit);
}
