// An opt-in strategy that spreads results across nodes (moca-spec ADR-0010).
// Pass its hooks to Search. Without it, a search can return its whole top
// list from one node's chunks.
//
// egress: keep each node's best `perNode` records in their ranked order, then
// the rest after them. Nothing is dropped, so the limit still fills. A node is
// its versioned reference, so its locales count as one node. The gate still
// runs last. Search fetches more than the limit whenever an egress hook is
// set, so there are other nodes to bring forward.

/** @returns {import('../search.js').SearchHooks} */
export function diversify({ perNode = 1 } = {}) {
  if (!Number.isInteger(perNode) || perNode < 1) throw new RangeError('perNode must be a positive integer');
  return {
    egress(candidates) {
      const counts = new Map();
      const first = [];
      const rest = [];
      for (const record of candidates) {
        const n = counts.get(record.node.ref) ?? 0;
        counts.set(record.node.ref, n + 1);
        (n < perNode ? first : rest).push(record);
      }
      return [...first, ...rest];
    },
  };
}
