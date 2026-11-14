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
  const positions = new Map();
  collection.members.forEach((member, i) => {
    const stack = [member];
    const seen = new Set();
    while (stack.length > 0) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      if (!positions.has(n)) positions.set(n, i);
      for (const e of [...graph.in('broader', n), ...graph.out('hasPart', n)]) stack.push(e.iri);
    }
  });
  return { iri, members: [...collection.members], positions };
}

/** The reading order as plain JSON, for a package state (contract §9.4). */
export function readingOrderState(order) {
  return { iri: order.iri, members: [...order.members], positions: [...order.positions].sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
}

/** A reading order from a package state, as resolveReadingOrder returns it. */
export function readingOrderFromState(state) {
  if (!state || !Array.isArray(state.members) || !Array.isArray(state.positions)) return null;
  return { iri: state.iri, members: state.members, positions: new Map(state.positions) };
}

/**
 * Contract §9: whether a record passes upTo, given its package's reading order (or null). A package whose reading
 * order does not have upTo as a member is not limited, nor is a record bound to no concept on it.
 */
export function passesUpTo(record, order, upTo) {
  if (!order || !order.members.includes(upTo)) return true;
  const limit = order.positions.get(upTo);
  return (record.concepts ?? []).every((c) => !order.positions.has(c) || order.positions.get(c) <= limit);
}
