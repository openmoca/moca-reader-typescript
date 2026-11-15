import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackage, directoryResolver, packageState, Library, Search, LexicalBackend } from '../lib/index.js';

// Reader contract §3: work stays bounded on hostile compositions and structures. Each test sets a time budget, and
// the composition test a memory budget, that the quadratic versions broke by orders of magnitude.

const ID = 'https://example.com/budget';

function pkg(dir, manifest, files = {}) {
  mkdirSync(join(dir, 'content'), { recursive: true });
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ mocaVersion: '0.7', version: '1.0.0', language: 'en', ...manifest }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

const node = (title) => `---\ntype: Note\ntitle: ${title}\n---\n# ${title}\n`;

async function pinOf(dir) {
  const r = await readPackage(dir);
  assert.ok(r.valid, `${dir} is valid`);
  return { id: r.manifest.id, version: '1.0.0', digest: r.digest };
}

test('a diamond of shared members reads each member once (contract §3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moca-budget-'));
  try {
    const N = 45;
    const leaves = [];
    for (let i = 0; i < N; i++) {
      const dir = join(root, 'pkgs', `leaf-${i}`);
      // One member carries 2 MiB, read 2,025 times without sharing.
      pkg(dir, { id: `${ID}/leaf-${i}`, title: `Leaf ${i}` }, {
        'content/a.md': node(`Leaf ${i}`),
        ...(i === 0 ? { 'sources/big.txt': 'x'.repeat(2 * 1024 * 1024) } : {}),
      });
      leaves.push(await pinOf(dir));
    }
    const mids = [];
    for (let i = 0; i < N; i++) {
      const dir = join(root, 'pkgs', `mid-${i}`);
      pkg(dir, { id: `${ID}/mid-${i}`, title: `Mid ${i}`, members: leaves });
      mids.push({ id: `${ID}/mid-${i}`, version: '1.0.0', digest: (await readPackage(dir, { resolveMember: directoryResolver([join(root, 'pkgs')]) })).digest });
    }
    const top = join(root, 'top');
    pkg(top, { id: `${ID}/top`, title: 'Top', members: mids });

    const resolver = directoryResolver([join(root, 'pkgs')]);
    let calls = 0;
    const before = process.memoryUsage().rss;
    const started = performance.now();
    const r = await readPackage(top, { resolveMember: (m) => { calls += 1; return resolver(m); } });
    const ms = performance.now() - started;
    const grew = process.memoryUsage().rss - before;

    assert.ok(r.valid);
    assert.equal(calls, 2 * N, 'each distinct member is resolved once');
    assert.ok(r.members.every((m) => m.status === 'resolved'));
    assert.ok(r.members[0].result.members.every((m) => m.status === 'resolved'), 'a shared member resolves for every composer');
    assert.ok(ms < 20_000, `read in ${Math.round(ms)} ms`);
    assert.ok(grew < 512 * 1024 * 1024, `memory grew by ${Math.round(grew / 1048576)} MiB`);

    // The byte budget: past it, no further member is resolved (R001).
    const capped = await readPackage(top, { resolveMember: resolver, limits: { maxMemberBytes: 1024 * 1024 } });
    assert.ok(capped.diagnostics.some((d) => d.code === 'R001_MEMBER_UNRESOLVED' && /bytes/.test(d.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a long reading order over a shared subtree resolves in linear time (contract §3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moca-budget-'));
  try {
    const N = 3000;
    const lines = ['@prefix skos: <http://www.w3.org/2004/02/skos/core#> .', '@prefix dcterms: <http://purl.org/dc/terms/> .'];
    lines.push(`<${ID}/order#list> a skos:OrderedCollection ; skos:memberList ( ${Array.from({ length: N }, (_, i) => `<${ID}/order#m${i}>`).join(' ')} ) .`);
    for (let i = 0; i < N; i++) lines.push(`<${ID}/order#m${i}> a skos:Concept ; dcterms:hasPart <${ID}/order#c0> .`);
    for (let i = 0; i < N; i++) lines.push(`<${ID}/order#c${i}> a skos:Concept${i + 1 < N ? ` ; dcterms:hasPart <${ID}/order#c${i + 1}>` : ''} .`);
    pkg(root, { id: `${ID}/order`, title: 'Order', readingOrder: `${ID}/order#list` }, { 'content/a.md': node('A'), 'structure.ttl': `${lines.join('\n')}\n` });

    const started = performance.now();
    const r = await readPackage(root);
    const ms = performance.now() - started;
    assert.ok(r.valid);
    const state = packageState(r);
    assert.equal(state.readingOrder.positions[`${ID}/order#c${N - 1}`], 0, 'the first member that reaches a concept places it');
    assert.equal(state.readingOrder.positions[`${ID}/order#m${N - 1}`], N - 1);
    assert.ok(ms < 5_000, `read in ${Math.round(ms)} ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindings by composition stay linear in work and in state size (contract §3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moca-budget-'));
  try {
    const N = 2000;
    const files = {};
    for (let i = 0; i < N; i++) files[`content/n${i}.md`] = node(`Node ${i}`);
    const memberDir = join(root, 'pkgs', 'member');
    pkg(memberDir, { id: `${ID}/member`, title: 'Member' }, files);
    const pin = await pinOf(memberDir);

    // Every node is bound, under a chain of N concepts: N × N ancestors if each node's were listed.
    const lines = ['@prefix skos: <http://www.w3.org/2004/02/skos/core#> .'];
    for (let i = 0; i < N; i++) lines.push(`<${ID}/composer#c${i}> a skos:Concept${i > 0 ? ` ; skos:broader <${ID}/composer#c${i - 1}>` : ''} .`);
    for (let i = 0; i < N; i++) lines.push(`<${ID}/member#n${i}.md> a skos:Concept ; skos:broader <${ID}/composer#c${N - 1}> .`);
    const composer = join(root, 'composer');
    pkg(composer, { id: `${ID}/composer`, title: 'Composer', members: [pin] }, { 'structure.ttl': `${lines.join('\n')}\n` });

    const before = process.memoryUsage().rss;
    const started = performance.now();
    const r = await readPackage(composer, { resolveMember: directoryResolver([join(root, 'pkgs')]) });
    assert.ok(r.valid);
    const size = JSON.stringify(packageState(r)).length;
    const library = new Library().add(r);
    const records = await new Search(library, { backend: new LexicalBackend(library) }).search('node', { scope: `${ID}/composer#c0`, limit: 100 });
    const listed = library.structure.nodes(`${ID}/composer#c0`);
    const ms = performance.now() - started;
    const grew = process.memoryUsage().rss - before;

    assert.equal(records.length, 100, 'search under the top of the chain finds bound nodes');
    assert.equal(listed.length, N, 'nodes() lists every bound node under the top of the chain');
    assert.ok(size < 1024 * 1024, `package state is ${size} bytes`);
    assert.ok(ms < 10_000, `read and searched in ${Math.round(ms)} ms`);
    assert.ok(grew < 512 * 1024 * 1024, `memory grew by ${Math.round(grew / 1048576)} MiB`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refined quote over a 4 MiB transcript is located in linear time (contract §3, §7)', async () => {
  const { locateQuote } = await import('../lib/evidence-text.js');
  // 4,096 cues of 1 KiB each: "a a a ...". Quadratic searches took minutes here.
  const text = 'a '.repeat(512);
  const cues = Array.from({ length: 4096 }, (_, i) => ({ start: i, end: i + 1, text }));
  const range = { start: 0, end: 4096 };
  for (const exact of ['a', 'a '.repeat(4096).trim()]) {
    const started = performance.now();
    const located = locateQuote(cues, range, { type: 'TextQuoteSelector', exact });
    const ms = performance.now() - started;
    assert.ok(located, `quote of ${exact.length} characters found`);
    assert.ok(ms < 10_000, `${exact.length}-character quote located in ${Math.round(ms)} ms`);
  }
});

test('a repeat of a member id (M005) is not resolved (contract §3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moca-budget-'));
  try {
    const leaf = join(root, 'pkgs', 'leaf');
    pkg(leaf, { id: `${ID}/leaf`, title: 'Leaf' }, { 'content/a.md': node('Leaf') });
    const pin = await pinOf(leaf);
    const fakes = Array.from({ length: 20 }, (_, i) => ({ ...pin, digest: `sha256:${String(i).padStart(64, '0')}` }));
    const top = join(root, 'top');
    pkg(top, { id: `${ID}/top`, title: 'Top', members: [pin, ...fakes] });
    const resolver = directoryResolver([join(root, 'pkgs')]);
    let calls = 0;
    const r = await readPackage(top, { resolveMember: (m) => { calls += 1; return resolver(m); } });
    assert.ok(r.diagnostics.some((d) => d.code === 'M005_DUPLICATE_MEMBER'));
    assert.equal(calls, 1, 'only the first entry for the id is resolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package and its members share one evidence budget (contract §3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moca-budget-'));
  try {
    const quoted = (title) => `---\ntype: Note\ntitle: ${title}\nsources:\n  - { id: s, resource: ../sources/s.txt }\nmoca:\n  evidence:\n    - { source: s, selector: { type: TextQuoteSelector, exact: the tide turns } }\n---\n# ${title}\n`;
    const files = (title) => ({ 'content/a.md': quoted(title), 'sources/s.txt': 'Here the tide turns at noon.' });
    const memberDir = join(root, 'pkgs', 'member');
    pkg(memberDir, { id: `${ID}/member`, title: 'Member' }, files('Member'));
    const top = join(root, 'top');
    pkg(top, { id: `${ID}/top`, title: 'Top', members: [await pinOf(memberDir)] }, files('Top'));
    const resolveMember = directoryResolver([join(root, 'pkgs')]);
    const matched = (r) => r.nodes[0].representations[0].evidenceChecks[0].matched;

    const full = await readPackage(top, { resolveMember });
    assert.equal(matched(full), true);
    assert.equal(matched(full.members[0].result), true);

    // One check in all: the composing package spends it, so its member's evidence is not checked.
    const one = await readPackage(top, { resolveMember, limits: { maxEvidenceChecksPerPackage: 1 } });
    assert.equal(matched(one), true);
    assert.equal(matched(one.members[0].result), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
