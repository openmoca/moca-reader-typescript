// What the terms gate covers, and hiding a closed package (moca-spec Reader contract §9.4, §10, §15.3–15.4;
// ADR-0041). The conformance corpus tests the same rules across Readers; these tests add what it cannot see: what an
// embedder receives at ingest, and the store search's own resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackage, directoryResolver, Library, Search, LexicalBackend, MemoryStoreBackend, packageState, validateAgainst } from '../lib/index.js';
import { resolveAi, closureOf, checkTerms, loosenedNodes } from '../lib/terms.js';

const repo = process.env.MOCA_SPEC_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'moca-spec');
const at = (p) => join(repo, 'conformance', p);
const M = 'fixtures/terms/mention/';
const NOW = () => new Date('2026-11-21T00:00:00Z');
const readOptions = { trustRoot: at('fixtures/trust-root.json'), clock: NOW };

async function library(paths, options = {}) {
  const lib = new Library({ clock: NOW });
  for (const p of paths) {
    const r = await readPackage(at(p), { ...readOptions, ...options });
    assert.equal(r.valid, true, p);
    lib.add(r);
  }
  return lib;
}

/** An embedder that records every text it is given. */
function recordingEmbedder() {
  const seen = [];
  return {
    seen,
    name: 'recording',
    dimensions: 2,
    embed: async (texts) => {
      seen.push(...texts);
      return texts.map(() => [1, 0]);
    },
  };
}

test('mention resolves at package level: default true, false whatever the authority, never from a node', () => {
  const unsigned = { terms: { ai: { allowed: { mention: false } } }, authority: 'unverified' };
  assert.deepEqual(resolveAi({ terms: {}, authority: 'unverified' }, 'a.md')['allowed.mention'], { value: true, decidedBy: 'platform' });
  assert.deepEqual(resolveAi(unsigned, 'a.md')['allowed.mention'], { value: false, decidedBy: 'package' });
  const node = { terms: { nodes: [{ paths: ['content/a.md'], ai: { allowed: { mention: false } } }] }, authority: 'unverified' };
  assert.deepEqual(resolveAi(node, 'a.md')['allowed.mention'], { value: true, decidedBy: 'platform' });
  // A malformed nodes container makes node permissions strictest, but mention has no node level.
  assert.deepEqual(resolveAi({ terms: { nodes: {} }, authority: 'unverified' }, 'a.md')['allowed.mention'], { value: true, decidedBy: 'platform' });
  // A malformed package container hides.
  assert.deepEqual(resolveAi({ terms: { ai: { allowed: false } }, authority: 'unverified' }, null)['allowed.mention'].value, false);
  // A host limit can hide, never unhide.
  assert.deepEqual(resolveAi({ terms: {}, authority: 'unverified' }, null, { allowed: { mention: false } })['allowed.mention'], { value: false, decidedBy: 'host' });
  assert.deepEqual(resolveAi(unsigned, null, { allowed: { mention: true } })['allowed.mention'], { value: false, decidedBy: 'package' });
});

test('mention in a nodes entry is U003 and never U002', () => {
  const terms = { ai: { allowed: { mention: false } }, nodes: [{ paths: ['content/a.md'], ai: { allowed: { mention: true } } }] };
  assert.deepEqual(checkTerms(terms).map((p) => `${p.code} ${p.path}`), ['U003_TERMS_UNKNOWN_VALUE nodes.0.ai.allowed.mention']);
  assert.deepEqual(loosenedNodes(terms), []);
});

test('closed and hidden: package level, by destination and conditions; a use never closes a package', () => {
  const ai = (allowed, providerRequires = []) => resolveAi({ terms: { ai: { allowed, providerRequires } }, authority: 'unverified' }, null);
  assert.deepEqual(closureOf({ ai: { destination: 'provider' } }, ai({ provider: false })), { closed: true, closedBy: ['ai.allowed.provider'], hidden: false });
  assert.deepEqual(closureOf({ ai: { destination: 'provider' } }, ai({ provider: false, mention: false })), { closed: true, closedBy: ['ai.allowed.provider'], hidden: true });
  assert.deepEqual(closureOf({ ai: { destination: 'device' } }, ai({ provider: false, mention: false })), { closed: false, closedBy: [], hidden: false });
  assert.deepEqual(closureOf({ ai: { destination: 'provider', conditions: ['noTraining'] } }, ai({}, ['noRetention'])).closedBy, ['ai.providerRequires']);
  assert.equal(closureOf({ ai: { destination: 'device', use: 'translate' } }, ai({ machineTranslation: false })).closed, false);
  assert.equal(closureOf({ rating: { explicit: false } }, ai({ provider: false, mention: false })).hidden, false);
});

test('ingest for a provider never sends closed text to the embedder, nor stores it; U004 counts it, with hidden', async () => {
  const lib = await library([M + 'open', M + 'closed-named', M + 'closed-hidden']);
  const embedder = recordingEmbedder();
  const store = new MemoryStoreBackend({ embedder });
  await store.ingest(lib, { terms: { destination: 'provider' } });
  // The fixtures' episodes share their words, so count: only the open package's one unit reaches the embedder.
  assert.equal(embedder.seen.length, 1, 'no unit from a closed package reaches the embedder');
  assert.deepEqual([...new Set(store.records.map((r) => r.hit.record.package.id))], ['https://example.com/conformance/terms-mention-open']);
  assert.equal(store.ingestDiagnostics.length, 1);
  const [u] = store.ingestDiagnostics;
  assert.equal(u.code, 'U004_TERMS_EXCLUDED');
  assert.deepEqual(u.excluded, { 'ai.allowed.provider': 3 });
  assert.equal(u.hidden, 2);

  const device = new MemoryStoreBackend({ embedder: recordingEmbedder() });
  await device.ingest(lib, { terms: { destination: 'device' } });
  assert.equal(device.records.length, 4);
  assert.deepEqual(device.ingestDiagnostics, []);
  const none = new MemoryStoreBackend();
  await none.ingest(lib);
  assert.equal(none.records.length, 4);
});

test('ingest applies the host terms limits as floors', async () => {
  const lib = await library([M + 'open']);
  const store = new MemoryStoreBackend();
  await store.ingest(lib, { terms: { destination: 'host' }, termsLimits: { allowed: { host: false } } });
  assert.equal(store.records.length, 0);
  assert.deepEqual(store.ingestDiagnostics[0].excluded, { 'ai.allowed.host': 1 });
});

test("a search's U004 carries the counts by reason and the hidden count", async () => {
  const lib = await library([M + 'closed-hidden', 'fixtures/terms/node-tightens']);
  const search = new Search(lib, { backend: new LexicalBackend(lib) });
  const records = await search.search('lantern', { limit: 10, terms: { ai: { destination: 'provider', use: 'answer' } } });
  assert.deepEqual(records.map((r) => r.node.path), ['public.md']);
  const u = search.diagnostics.find((d) => d.code === 'U004_TERMS_EXCLUDED');
  assert.deepEqual(u.excluded, { 'ai.allowed.provider': 3 });
  assert.equal(u.hidden, 2);
});

test('a store search leaves hidden packages out of supersededBy, from the package states', async () => {
  const lib = await library([M + 'supersede/v1', M + 'supersede/v2']);
  const store = new MemoryStoreBackend({ filterPushdown: false });
  await store.ingest(lib);
  const states = lib.packages.map(({ result }) => packageState(result));
  const search = new Search({ packages: states, clock: NOW }, { backend: store });
  const provider = await search.search('lantern', { limit: 10, includeAll: true, terms: { ai: { destination: 'provider', use: 'answer' } } });
  assert.deepEqual(provider.map((r) => r.package.version), ['1.0.0']);
  assert.equal(provider[0].trust.superseded, true);
  assert.equal(provider[0].trust.supersededBy, undefined);
  const device = await search.search('lantern', { limit: 10, includeAll: true, terms: { ai: { destination: 'device', use: 'answer' } } });
  const v1 = device.find((r) => r.package.version === '1.0.0');
  assert.deepEqual(v1.trust.supersededBy, ['https://example.com/conformance/terms-mention-supersede@2.0.0']);
});

test('the catalogue names a closed package with exactly six fields, and has no entry for a hidden one', async () => {
  const lib = await library([M + 'open', M + 'closed-named', M + 'closed-hidden']);
  const entries = lib.catalogue({ terms: { ai: { destination: 'provider', use: 'answer' } } });
  for (const e of entries) assert.deepEqual(validateAgainst('catalogueEntry', e), []);
  assert.deepEqual(entries.map((e) => e.id), ['https://example.com/conformance/terms-mention-closed-named', 'https://example.com/conformance/terms-mention-open']);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['closedBy', 'id', 'publisher', 'signed', 'title', 'version']);
  assert.equal(JSON.stringify(entries).includes('hidden'), false, 'the hidden package is named nowhere');
  // Without a request every package has an open entry.
  assert.equal(lib.catalogue().length, 3);
});

test('structureFor builds the structure from the packages not closed for the request', async () => {
  const lib = await library(['fixtures/terms/structure/open', 'fixtures/terms/structure/closed']);
  const T = 'https://example.org/conformance/terms-structure#';
  const gated = lib.structureFor({ terms: { ai: { destination: 'provider', use: 'answer' } } });
  assert.deepEqual(gated.concept(`${T}Topic`).labels, { en: 'Harbours' });
  assert.equal(gated.concept(`${T}Topic`).definition, undefined);
  assert.equal(gated.concept(`${T}Closed`), null);
  assert.deepEqual(gated.nodes(`${T}Topic`, { include: 'narrower' }).map((r) => r.package.id), []);
  // No request, or one without an ai part, is the whole structure.
  assert.equal(lib.structureFor(), lib.structure);
  assert.equal(lib.structureFor({ terms: { rating: { explicit: false } } }), lib.structure);
  assert.equal(lib.structureFor({ terms: { ai: { destination: 'device' } } }).concept(`${T}Topic`).definition, 'Text a provider may not receive.');
});

test('a composing package that speaks for its member can hide it; an unsigned one cannot', async () => {
  const members = { resolveMember: directoryResolver([at('fixtures/terms/composite/member')]) };
  const signed = await library(['fixtures/terms/composite/hides'], members);
  // The member allows every destination, so it is never closed, and so never hidden: mention changes nothing.
  assert.equal(signed.catalogue({ terms: { ai: { destination: 'host' } } }).length, 2);
  const search = new Search(signed, { backend: new LexicalBackend(signed) });
  const [r] = await search.search('lantern', { terms: { ai: { destination: 'device', use: 'answer' } } });
  assert.deepEqual(r.terms.ai.allowed.mention, { value: false, decidedBy: 'composite' });
  const unsigned = await library(['fixtures/terms/composite/hides-unsigned'], members);
  const s2 = new Search(unsigned, { backend: new LexicalBackend(unsigned) });
  const [r2] = await s2.search('lantern', { terms: { ai: { destination: 'device', use: 'answer' } } });
  assert.deepEqual(r2.terms.ai.allowed.mention, { value: true, decidedBy: 'platform' });
});
