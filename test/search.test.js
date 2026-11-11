import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packageState,
  readPackage, bindSidecar, Library, Search, LexicalBackend, DenseBackend, MemoryStoreBackend, validateAgainst, diversify, similarity, modelMismatch, HybridBackend,
} from '../lib/index.js';
import { toyEmbedder } from './fixtures/toy-embedder.js';

const repo = process.env.MOCA_SPEC_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'moca-spec');
const at = (p) => join(repo, p);

async function policyLibrary() {
  const library = new Library();
  for (const p of ['examples/policy-corpus/retention-2025', 'examples/policy-corpus/retention-2026']) library.add(await readPackage(at(p)));
  return library;
}

async function supportKb({ sidecar = false } = {}) {
  const pkg = await readPackage(at('examples/support-kb'));
  const library = new Library();
  if (!sidecar) return { library: library.add(pkg), pkg };
  const bound = bindSidecar(at('examples/sidecars/support-kb.moca.idx'), pkg);
  return { library: library.add(pkg, { chunks: bound.chunks, index: bound.index }), pkg, bound };
}

// A backend that ignores every filter and returns whatever it is given.
const rawBackend = (hits) => ({ features: ['lexical'], search: () => hits });

test('search results are schema-valid citation records and the default policy applies', async () => {
  const library = await policyLibrary();
  const search = new Search(library, { backend: new LexicalBackend(library) });
  const results = await search.search('customer records retention');
  assert.deepEqual(results.map((r) => r.package.version), ['2.0.0']);
  for (const r of results) assert.deepEqual(validateAgainst('citationRecord', r), []);
  const all = await search.search('customer records retention', { includeAll: true });
  assert.deepEqual(all.map((r) => r.package.version).sort(), ['1.0.0', '2.0.0']);
});

test('Search re-checks every hit, whatever a backend without pushdown returns', async () => {
  const library = await policyLibrary();
  const [old, current] = library.packages.map((p) => p.result);
  const hit = (result, extra = {}) => ({ digest: result.digest, node: `${result.manifest.id}#customer-records.md`, path: 'customer-records.md', score: 1, ...extra });
  const search = new Search(library, {
    backend: rawBackend([
      hit(old, { score: 9 }),
      hit(current, { digest: `sha256:${'0'.repeat(64)}` }),
      hit(current, { node: 'https://example.com/other#customer-records.md' }),
      hit(current, { path: 'missing.md', node: `${current.manifest.id}#missing.md` }),
      hit(current, { span: { start: 0, end: 10 ** 9 } }),
      hit(current, { score: 2 }),
    ]),
  });
  const results = await search.search('anything');
  assert.equal(results.length, 1);
  assert.equal(results[0].package.version, '2.0.0');
  assert.equal(results[0].score, 2);
});

test('retrieval hooks cannot widen what the gate returns', async () => {
  const library = await policyLibrary();
  const versions = (rs) => rs.map((r) => r.package.version);
  const plain = await new Search(library, { backend: new LexicalBackend(library) }).search('customer records retention', { limit: 1 });
  const hostile = new Search(library, {
    backend: new LexicalBackend(library),
    hooks: {
      ingress: () => ({ includeAll: true, limit: 50, locale: 'fr' }),
      egress: (candidates, ctx) => {
        assert.throws(() => { ctx.request.includeAll = true; }, TypeError);
        return [...candidates, ...library.citations({ includeText: true })];
      },
    },
  });
  const results = await hostile.search('customer records retention', { limit: 1 });
  assert.deepEqual(versions(results), versions(plain));
  assert.deepEqual(versions(results), ['2.0.0']);
});

test('the host audience set is applied to every backend and cannot be widened', async () => {
  const { library, pkg } = await supportKb();
  const hits = pkg.nodes.map((n) => ({ digest: pkg.digest, node: `${pkg.manifest.id}#${n.path}`, path: n.path, score: 1 }));
  const search = new Search(library, { backend: rawBackend(hits), audiences: ['public'] });
  const results = await search.search('x', { limit: 20, includeAll: true });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => !r.audience || r.audience === 'public'));
  const lexical = library.search('delete account', { audiences: ['public'], includeAll: true });
  assert.ok(lexical.every((r) => r.audience !== 'internal'));
});

test('a requested locale is honoured over sidecar chunks', async () => {
  const { library } = await supportKb({ sidecar: true });
  const fr = library.search('remboursement refund', { locale: 'fr', limit: 10 });
  assert.ok(fr.length > 0);
  for (const r of fr) {
    if (r.node.path === 'refund-window.md') assert.equal(r.node.locale, 'fr');
  }
  const en = library.search('remboursement refund', { locale: 'en', limit: 10 });
  assert.ok(en.every((r) => r.node.locale === 'en'));
  const chunk = fr.find((r) => r.node.path === 'refund-window.md');
  assert.match(chunk.text, /Délai de remboursement/);
});

test('sidecar chunks without text are searched by the package text they point at', async () => {
  const { library } = await supportKb({ sidecar: true });
  for (const p of library.packages) p.chunks = p.chunks.map(({ text, ...c }) => c);
  const lexical = await new Search(library, { backend: new LexicalBackend(library) }).search('domestic express', { limit: 1 });
  assert.equal(lexical[0]?.node.path, 'shipping-estimates.md');
  assert.ok(lexical[0].span && lexical[0].text.includes('Domestic'));
  const store = await new MemoryStoreBackend().ingest(library);
  const stored = await new Search({ packages: library.packages.map((p) => packageState(p.result)) }, { backend: store }).search('domestic express', { limit: 1 });
  assert.equal(stored[0]?.node.path, 'shipping-estimates.md');
  assert.ok(stored[0].text.includes('Domestic'));
});

test('a dense backend searches sidecar vectors only when the host embedder matches the model', async () => {
  const { library, pkg } = await supportKb();
  const embedder = toyEmbedder();
  const texts = [];
  for (const node of pkg.nodes) {
    for (const rep of node.representations) texts.push({ path: node.path, locale: rep.locale, start: rep.bodyOffset, end: rep.bodyOffset + Buffer.byteLength(rep.body), text: rep.body });
  }
  const vectors = await embedder.embed(texts.map((t) => t.text));
  const chunks = texts.map((t, i) => ({ path: t.path, ...(t.locale ? { locale: t.locale } : {}), start: t.start, end: t.end, text: t.text, vector: vectors[i] }));
  library.packages[0].chunks = chunks;
  library.packages[0].index = { model: { name: 'toy-bow', version: '1', dimensions: 16 } };

  const dense = new DenseBackend(library, { embedder });
  assert.deepEqual(dense.diagnostics, []);
  const results = await new Search(library, { backend: dense }).search('refund within days of delivery');
  assert.equal(results[0].node.path, 'refund-window.md');
  assert.ok(results.every((r) => typeof r.score === 'number'));

  for (const other of [toyEmbedder({ name: 'another-model' }), toyEmbedder({ version: '2' }), toyEmbedder({ dimensions: 8 })]) {
    const refused = new DenseBackend(library, { embedder: other });
    assert.deepEqual(refused.diagnostics.map((d) => d.code), ['S006_MODEL_MISMATCH']);
    assert.deepEqual(await new Search(library, { backend: refused }).search('refund'), []);
  }
});

test('a dense backend reports every loaded package it has no vectors for', async () => {
  const { library } = await supportKb({ sidecar: true });
  library.add(await readPackage(at('examples/minimal')));
  const dense = new DenseBackend(library, { embedder: toyEmbedder() });
  assert.deepEqual(dense.diagnostics.map((d) => d.code), ['S007_NO_VECTORS', 'S007_NO_VECTORS']);
  assert.deepEqual(await new Search(library, { backend: dense }).search('refund'), []);
});

test('diversify brings other nodes forward, and Search fetches past the limit for it', async () => {
  const { library, pkg } = await supportKb();
  const body = (path) => pkg.nodes.find((n) => n.path === path).representations[0].bodyOffset;
  const hit = (path, at, score) => ({ digest: pkg.digest, node: `${pkg.manifest.id}#${path}`, path, span: { start: body(path) + at, end: body(path) + at + 20 }, score });
  const asked = [];
  const backend = {
    features: ['lexical', 'filterPushdown'],
    search: (q, { limit }) => {
      asked.push(limit);
      return [hit('refund-window.md', 0, 9), hit('refund-window.md', 30, 8), hit('refund-window.md', 60, 7), hit('shipping-estimates.md', 0, 6)].slice(0, limit);
    },
  };
  const paths = (rs) => rs.map((r) => r.node.path);
  assert.deepEqual(paths(await new Search(library, { backend }).search('x', { limit: 2 })), ['refund-window.md', 'refund-window.md']);
  const spread = await new Search(library, { backend, hooks: diversify() }).search('x', { limit: 2 });
  assert.deepEqual(paths(spread), ['refund-window.md', 'shipping-estimates.md']);
  assert.deepEqual(asked, [2, 6]);
  const two = await new Search(library, { backend, hooks: diversify({ perNode: 2 }) }).search('x', { limit: 3 });
  assert.deepEqual(paths(two), ['refund-window.md', 'refund-window.md', 'shipping-estimates.md']);
  assert.throws(() => diversify({ perNode: 0 }), RangeError);
});

test('embedders get a role, and declared prefixes are compared, never applied', async () => {
  const roles = [];
  const recording = (extra = {}) => ({ ...toyEmbedder(), ...extra, embed: async (texts, options) => { roles.push(options?.role); return toyEmbedder().embed(texts); } });
  const { library } = await supportKb();
  const store = await new MemoryStoreBackend({ embedder: recording() }).ingest(library);
  await new Search({ packages: library.packages.map((p) => packageState(p.result)) }, { backend: store }).search('refund');
  assert.deepEqual(roles, ['document', 'query']);

  const index = { model: { name: 'toy-bow', version: '1', dimensions: 16, queryPrefix: 'query: ', documentPrefix: 'passage: ' } };
  const mismatch = (extra) => modelMismatch({ ...toyEmbedder(), ...extra }, index.model, 16);
  assert.equal(mismatch({ queryPrefix: 'query: ', documentPrefix: 'passage: ' }), null);
  // Contract §9.3 (0.6): a prefix declared on one side only is a mismatch.
  assert.match(mismatch({}), /queryPrefix/);
  assert.match(mismatch({ queryPrefix: 'search_query: ', documentPrefix: 'passage: ' }), /queryPrefix/);
  assert.match(mismatch({ queryPrefix: 'query: ', documentPrefix: 'search_document: ' }), /documentPrefix/);
});

test('a hybrid backend fuses ranks, weighted by the host, and keeps what the dense side skips', async () => {
  const hit = (node, start) => ({ digest: 'sha256:x', node: `p#${node}`, path: node, span: { start, end: start + 1 }, score: 9 });
  const fixed = (features, hits) => ({ features, diagnostics: [], search: (q, { limit }) => hits.slice(0, limit) });
  const lexical = fixed(['lexical', 'filterPushdown'], [hit('a.md', 0), hit('b.md', 0), hit('c.md', 0)]);
  const dense = { ...fixed(['dense', 'filterPushdown'], [hit('b.md', 0), hit('d.md', 0)]), diagnostics: [{ code: 'S007_NO_VECTORS' }] };
  const nodes = (hits) => hits.map((h) => h.path);
  const plain = new HybridBackend({ lexical, dense });
  const fused = await plain.search('q', { limit: 10, filters: {} });
  assert.deepEqual(nodes(fused), ['b.md', 'a.md', 'd.md', 'c.md']);
  assert.equal(fused[0].score, Math.round((1 / 62 + 1 / 61) * 1e6) / 1e6);
  assert.deepEqual(plain.features, ['lexical', 'dense', 'filterPushdown']);
  assert.deepEqual(plain.diagnostics.map((d) => d.code), ['S007_NO_VECTORS']);
  assert.deepEqual(nodes(await new HybridBackend({ lexical, dense, weights: { lexical: 0 } }).search('q', { limit: 10, filters: {} })), ['b.md', 'd.md']);
  assert.deepEqual(nodes(await new HybridBackend({ lexical, dense, weights: { dense: 3 } }).search('q', { limit: 2, filters: {} })), ['b.md', 'd.md']);
  assert.throws(() => new HybridBackend({ lexical, dense, weights: { lexical: 0, dense: 0 } }), RangeError);
  assert.throws(() => new HybridBackend({ lexical, dense, k: -1 }), RangeError);
});

test('vectors are scored by the index distance, higher always better', () => {
  assert.equal(similarity(undefined, [1, 0], [3, 3]).toFixed(4), '0.7071');
  assert.equal(similarity('cosine', [1, 0], [3, 3]).toFixed(4), '0.7071');
  assert.equal(similarity('dot', [1, 0], [3, 3]), 3);
  assert.equal(similarity('euclidean', [1, 0], [1, 0]), 0);
  assert.ok(similarity('euclidean', [1, 0], [0.9, 0.1]) > similarity('euclidean', [1, 0], [10, 0]));
});

test('a store backend never returns records from a package version that is not loaded', async () => {
  const both = await policyLibrary();
  const store = await new MemoryStoreBackend({ filterPushdown: false }).ingest(both);
  const onlyOld = new Library().add(both.packages[0].result);
  const results = await new Search(onlyOld, { backend: store }).search('customer records retention', { includeAll: true });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.package.digest === both.packages[0].result.digest));

  const dense = await new MemoryStoreBackend({ embedder: toyEmbedder() }).ingest(both);
  const current = await new Search(both, { backend: dense }).search('customer records retention');
  assert.deepEqual([...new Set(current.map((r) => r.package.version))], ['2.0.0']);
});

test('concept filters return only content bound to one of the concepts', async () => {
  const library = new Library().add(await readPackage(at('examples/service-catalogue')));
  const search = new Search(library, { backend: new LexicalBackend(library) });
  const order = await search.search('service data', { concepts: ['https://example.org/services#OrderDatabase'] });
  assert.deepEqual(order.map((r) => r.node.path), ['order-service.md']);
  assert.deepEqual(order[0].concepts, ['https://example.org/services#OrderService', 'https://example.org/services#OrderDatabase']);
  const store = await new MemoryStoreBackend({ filterPushdown: false }).ingest(library);
  const viaStore = await new Search(library, { backend: store }).search('service data', { concepts: ['https://example.org/services#ServiceBoundary'] });
  assert.deepEqual(viaStore.map((r) => r.node.path), ['service-boundaries.md']);
});

test('searchSync refuses an asynchronous backend', async () => {
  const library = await policyLibrary();
  const search = new Search(library, { backend: { features: [], search: async () => [] } });
  assert.throws(() => search.searchSync('x'), /asynchronous/);
});

test('a store is searched from its ingest-time records, with only the package states and a clock', async () => {
  const both = await policyLibrary();
  const store = await new MemoryStoreBackend({ filterPushdown: false }).ingest(both);
  const [v1, v2] = both.packages.map((p) => p.result.digest);
  const [s1, s2] = both.packages.map((p) => packageState(p.result));
  const now = () => new Date('2026-09-27T00:00:00Z');

  const current = await new Search({ packages: [s2], clock: now }, { backend: store }).search('customer records retention', { includeAll: true });
  assert.ok(current.length > 0);
  assert.ok(current.every((r) => r.package.digest === v2), 'records from a digest the host has not allowed are dropped');
  for (const r of current) assert.deepEqual(validateAgainst('citationRecord', { ...r }), []);

  // retention-2026 is in force from 2026-04-01: the clock is re-applied to the stored record.
  const before = await new Search({ packages: [s2], clock: () => new Date('2026-01-01T00:00:00Z') }, { backend: store }).search('customer records retention');
  assert.deepEqual(before, []);
  const old = await new Search({ packages: [s1], clock: now }, { backend: store }).search('customer records retention', { includeAll: true });
  assert.ok(old.every((r) => r.package.digest === v1));
});
