import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackage, packageState, citationFor, Library, Search } from '../lib/index.js';

// Package spec §4.10 and Reader contract §9: readingOrder and upTo. The corpus covers the rules; these cover what it cannot.
const B = 'https://example.org/c#';
const HEAD = '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n@prefix c: <https://example.org/c#> .\n';
const node = (concepts) => `---\ntype: Note\ntitle: A\n${concepts.length ? `moca:\n  concepts:\n${concepts.map((c) => `    - iri: ${B}${c}\n`).join('')}` : ''}---\n\n# A\n\nText.\n`;

function makePackage(structure, nodes = { 'content/a.md': node([]) }, manifest = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-reading-order-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/t', version: '1.0.0', title: 'T', readingOrder: `${B}Path`, ...manifest }));
  if (structure !== null) writeFileSync(join(dir, 'structure.ttl'), HEAD + structure);
  for (const [path, data] of Object.entries(nodes)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  return dir;
}
const codes = (r) => r.diagnostics.map((d) => d.code);

test('an empty member list, or a list with no OrderedCollection type, does not resolve', async () => {
  const empty = await readPackage(makePackage('c:Path a skos:OrderedCollection ; skos:memberList () .\n'));
  assert.deepEqual(codes(empty), ['M014_READING_ORDER_UNRESOLVED']);
  assert.equal(empty.readingOrder, undefined);
  const untyped = await readPackage(makePackage('c:A a skos:Concept .\nc:Path skos:memberList ( c:A ) .\n'));
  assert.ok(codes(untyped).includes('M014_READING_ORDER_UNRESOLVED'));
});

test('a narrower cycle does not stop placement, and each concept keeps its first position', async () => {
  const ttl = 'c:A a skos:Concept ; skos:narrower c:B .\nc:B a skos:Concept ; skos:narrower c:A .\nc:C a skos:Concept .\n'
    + 'c:Path a skos:OrderedCollection ; skos:memberList ( c:A c:C c:B ) .\n';
  const r = await readPackage(makePackage(ttl, { 'content/a.md': node(['A']), 'content/b.md': node(['B']), 'content/c.md': node(['C']) }));
  assert.equal(r.readingOrder, `${B}Path`);
  const lib = new Library().add(r);
  const all = { features: [], search: () => r.nodes.map((n) => ({ digest: r.digest, node: `${r.manifest.id}#${n.path}`, path: n.path, score: 1 })) };
  // B is a member at index 2, but sits under A at index 0, so it passes at upTo A.
  const paths = (await new Search(lib, { backend: all }).search('x', { limit: 10, upTo: `${B}A` })).map((x) => x.node.path).sort();
  assert.deepEqual(paths, ['a.md', 'b.md']);
});

test('a package state carries the reading order as JSON, and a store search applies it', async () => {
  const ttl = 'c:A a skos:Concept .\nc:B a skos:Concept .\nc:__proto__ a skos:Concept .\n'
    + 'c:Path a skos:OrderedCollection ; skos:memberList ( c:A c:B ) .\n';
  // __proto__ is off the reading order: a lookup must not find Object.prototype.
  const r = await readPackage(makePackage(ttl, { 'content/a.md': node(['A']), 'content/b.md': node(['B']), 'content/p.md': node(['__proto__']) }));
  const state = JSON.parse(JSON.stringify(packageState(r)));
  assert.deepEqual(state.readingOrder, { iri: `${B}Path`, members: [`${B}A`, `${B}B`], positions: { [`${B}A`]: 0, [`${B}B`]: 1 } });
  const store = { features: [], search: () => r.nodes.map((n) => ({ record: citationFor(r, n, n.representations[0], { now: new Date() }), score: 1 })) };
  const paths = (await new Search({ packages: [state] }, { backend: store }).search('x', { limit: 10, upTo: `${B}A` })).map((x) => x.node.path).sort();
  assert.deepEqual(paths, ['a.md', 'p.md']);
});

test('readingOrder is ignored, without M014, when the manifest fails its schema', async () => {
  const r = await readPackage(makePackage(null, undefined, { readingOrder: 'not an iri' }));
  assert.deepEqual(codes(r), ['M002_MANIFEST_SCHEMA']);
  assert.equal(r.readingOrder, undefined);
});

test('a concept named __proto__ on the reading order survives a JSON round trip of the state', async () => {
  const ttl = 'c:A a skos:Concept .\nc:__proto__ a skos:Concept .\nc:Path a skos:OrderedCollection ; skos:memberList ( c:A c:__proto__ ) .\n';
  const r = await readPackage(makePackage(ttl, { 'content/a.md': node(['A']), 'content/p.md': node(['__proto__']) }));
  const state = JSON.parse(JSON.stringify(packageState(r)));
  assert.equal(Object.hasOwn(state.readingOrder.positions, `${B}__proto__`), true);
  const store = { features: [], search: () => r.nodes.map((n) => ({ record: citationFor(r, n, n.representations[0], { now: new Date() }), score: 1 })) };
  const paths = (await new Search({ packages: [state] }, { backend: store }).search('x', { limit: 10, upTo: `${B}A` })).map((x) => x.node.path);
  assert.deepEqual(paths, ['a.md']);
});

test('S008 is reported for the latest search only, and a store search reports it too', async () => {
  const ttl = 'c:A a skos:Concept .\nc:Path a skos:OrderedCollection ; skos:memberList ( c:A ) .\n';
  const r = await readPackage(makePackage(ttl, { 'content/a.md': node(['A']) }));
  const store = { features: [], search: () => r.nodes.map((n) => ({ record: citationFor(r, n, n.representations[0], { now: new Date() }), score: 1 })) };
  const search = new Search({ packages: [packageState(r)] }, { backend: store });
  await search.search('x', { upTo: `${B}Nowhere` });
  assert.deepEqual(search.diagnostics.map((d) => d.code), ['S008_UPTO_UNRESOLVED']);
  await search.search('x', { upTo: `${B}A` });
  assert.deepEqual(search.diagnostics, []);
});
