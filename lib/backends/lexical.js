// Lexical (BM25) backend over the packages in a library: each package's
// sidecar chunks when it was added with them, otherwise its nodes. With a
// locale, the representation package spec §5 selects for it; without one,
// every representation, so content in any language can be found, and the
// best-scoring one for each node is returned. Each document's term counts are
// kept per package digest after its first search, so later searches only score;
// they are dropped when the package leaves the library.
//
// Contract §9.2: filters remove records, they never change a score. BM25 counts
// every representation of every loaded package, then the filters apply, so a
// record scores the same whether or not a filter was pushed down. `accept`, a
// Reader-internal candidate check (upTo, concepts bound by composition), is
// applied the same way: after scoring.
import { audienceAllowed, audienceOf } from '../audience.js';
import { citationFor, pickRepresentation } from '../citation.js';
import { bm25Counted, countTerms } from './bm25.js';
import { chunkText } from '../sidecar.js';

export class LexicalBackend {
  /** @param {import('../library.js').Library} library */
  constructor(library) {
    this.library = library;
    this.features = ['lexical', 'filterPushdown'];
    this.diagnostics = [];
    /** @type {Map<string, Map<string, { terms: Map<string, number>, length: number }>>} */
    this.counted = new Map();
  }

  /** @returns {import('../search.js').SearchHit[]} */
  search(query, { limit, filters }) {
    const excluded = new Set((filters.exclude ?? []).map((x) => `${x.digest} ${x.node}`));
    const digests = filters.digests ? new Set(filters.digests) : null;
    const docs = [];
    const loaded = new Set(this.library.packages.map((p) => p.result.digest));
    for (const digest of this.counted.keys()) if (!loaded.has(digest)) this.counted.delete(digest);
    for (const { result, chunks } of this.library.packages) {
      if (digests && !digests.has(result.digest)) continue;
      if (!this.counted.has(result.digest)) this.counted.set(result.digest, new Map());
      const counted = this.counted.get(result.digest);
      const counts = (cacheKey, text) => {
        let c = counted.get(cacheKey);
        if (!c) counted.set(cacheKey, (c = countTerms(text())));
        return c;
      };
      const byPath = new Map(result.nodes.map((n) => [n.path, n]));
      const keep = (node, rep) => `${result.manifest.id}#${node.path}`;
      if (chunks) {
        for (const c of chunks) {
          const node = byPath.get(c.path);
          const rep = node?.representations.find((r) => (r.locale ?? null) === (c.locale ?? null));
          if (!rep) continue;
          const id = keep(node, rep);
          const key = `${id}\u0000${String(c.start).padStart(12, '0')}`;
          docs.push({
            item: { hit: { digest: result.digest, node: id, path: node.path, ...(rep.locale ? { locale: rep.locale } : {}), span: { start: c.start, end: c.end } }, node, rep },
            // The cache key adds the locale: chunks of two representations can start at the same offset.
            counts: counts(`${key}\u0000${c.locale ?? ''}`, () => `${citationFor(result, node, rep).node.title ?? ''} ${chunkText(c, rep)}`),
            key,
          });
        }
      } else {
        for (const node of result.nodes) {
          for (const rep of node.representations) {
            const id = keep(node, rep);
            const fm = rep.frontmatter;
            const key = `${id}\u0000${rep.locale ?? ''}`;
            docs.push({
              item: { hit: { digest: result.digest, node: id, path: node.path, ...(rep.locale ? { locale: rep.locale } : {}) }, node, rep },
              counts: counts(key, () => [fm.title, fm.description, ...(Array.isArray(fm.tags) ? fm.tags : []), rep.body].filter((x) => typeof x === 'string').join(' ')),
              key,
            });
          }
        }
      }
    }
    const passes = ({ hit, node, rep }) => !excluded.has(`${hit.digest} ${hit.node}`)
      && (!filters.locale || pickRepresentation(node, filters.locale) === rep)
      && audienceAllowed(audienceOf(node, rep), filters.audiences, filters.allowUnlabelled)
      && (!filters.concepts || (rep.concepts ?? []).some((c) => filters.concepts.includes(c)))
      && (typeof filters.accept !== 'function' || filters.accept(hit));
    const seen = new Set();
    const out = [];
    for (const { item, score } of bm25Counted(docs, query)) {
      if (out.length >= limit) break;
      if (!passes(item)) continue;
      const { hit } = item;
      // Node ids repeat across versions of a package, so key on the digest too.
      if (!hit.span) {
        const key = `${hit.digest} ${hit.node}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push({ ...hit, score });
    }
    return out;
  }
}
