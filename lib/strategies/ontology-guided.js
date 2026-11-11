// The default ontology-guided retrieval strategy (moca-spec ADR-0010). Opt-in: pass
// its hooks to Search. Applications and domain extensions may replace it.
//
// ingress: when the query names concepts by their label, search those
//   concepts and their descendants.
// egress: after each result, add the nodes of the concepts it requires
//   (transitively), tagged retrieval.via = "requires".
// The Reader's gate still applies the retrieval policy to everything added.
import { preferred } from '../structure.js';

const WORD = /[\p{L}\p{N}]+/gu;
const words = (text) => (text.toLowerCase().match(WORD) ?? []);

/** @returns {import('../search.js').SearchHooks} */
export function ontologyGuided({ expandRequires = true } = {}) {
  return {
    ingress(query, ctx) {
      if (!ctx.structure) return {};
      const q = new Set(words(query));
      const matched = [];
      for (const c of ctx.structure.graph.concepts.values()) {
        if (!c.declared) continue;
        const label = preferred(c.labels);
        const w = label ? words(label) : [];
        if (w.length > 0 && w.every((x) => q.has(x))) matched.push(c.iri);
      }
      if (matched.length === 0) return {};
      const concepts = new Set(matched);
      for (const iri of matched) for (const d of ctx.structure.descendants(iri)) concepts.add(d);
      return { concepts: [...concepts].sort() };
    },

    egress(candidates, ctx) {
      if (!expandRequires || !ctx.structure) return candidates;
      const out = [];
      const seen = new Set(candidates.map((r) => r.node.ref));
      for (const record of candidates) {
        out.push(record);
        for (const concept of record.concepts ?? []) {
          for (const req of ctx.structure.requires(concept, { transitive: true })) {
            for (const node of ctx.structure.nodes(req.iri, { locale: ctx.request.locale })) {
              if (seen.has(node.node.ref)) continue;
              seen.add(node.node.ref);
              out.push({ ...node, score: record.score, retrieval: { via: 'requires', from: concept } });
            }
          }
        }
      }
      return out;
    },
  };
}
