import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localeList, lookup, localeMatches } from '../lib/locale.js';
import { pickRepresentation } from '../lib/citation.js';

const node = (language, ...tags) => ({
  ...(language ? { language } : {}),
  representations: [{ locale: null, file: 'a.md' }, ...tags.map((t) => ({ locale: t, file: `a.${t}.md` }))],
});
const pick = (n, locale) => {
  const r = pickRepresentation(n, locale);
  return r.locale ?? 'default';
};

test('package spec §5.4: a sibling region is found through the truncated request', () => {
  assert.equal(pick(node('en', 'pt-BR', 'pt-PT'), 'pt-AO'), 'pt-BR');
  assert.equal(pick(node('en', 'es-ES'), 'es-419'), 'es-ES');
  assert.equal(pick(node('en', 'fr-CA'), 'fr-BE'), 'fr-CA');
});

test('package spec §5.4: the default file is tagged with the manifest language', () => {
  assert.equal(pick(node('en', 'en-GB'), 'en'), 'default');
  assert.equal(pick(node('en', 'en-GB'), 'en-US'), 'default');
  assert.equal(pick(node('en', 'en-GB'), 'en-GB'), 'en-GB');
  // With no manifest language the default is only the fallback.
  assert.equal(pick(node(undefined, 'en-GB'), 'en'), 'en-GB');
});

test('package spec §5.4: equal before longer, at each truncation', () => {
  assert.equal(pick(node('en', 'fr', 'fr-BE'), 'fr-CA'), 'fr');
  assert.equal(pick(node('en', 'zh-Hant-HK', 'zh-Hans'), 'zh-Hant-TW'), 'zh-Hant-HK');
  assert.equal(pick(node('en', 'pt-PT', 'pt-BR'), 'pt'), 'pt-BR');
  assert.equal(pick(node('en', 'PT-br'), 'pt-br'), 'PT-br');
});

test('package spec §5.4: a priority list tries each entry in full before the next', () => {
  assert.equal(pick(node('en', 'fr', 'de'), ['it', 'de', 'fr']), 'de');
  assert.equal(pick(node('en', 'fr'), ['fr-CA', 'en']), 'fr');
  assert.equal(pick(node('de', 'fr'), ['it', 'de']), 'default');
  assert.equal(pick(node('en', 'fr'), ['it', 'ja']), 'default');
  assert.equal(pick(node('en', 'fr'), []), 'default');
});

test('localeList and localeMatches', () => {
  assert.deepEqual(localeList('fr'), ['fr']);
  assert.deepEqual(localeList(['fr', 3, '', 'en']), ['fr', 'en']);
  assert.deepEqual(localeList(undefined), []);
  assert.equal(localeMatches('fr', 'fr-CA'), true);
  assert.equal(localeMatches('pt-BR', 'pt-AO'), true);
  assert.equal(localeMatches('en', 'fr'), false);
  assert.equal(localeMatches(undefined, 'fr'), false);
  assert.equal(lookup([{ tag: 'x', value: 1 }], 'en-a-bbb'), undefined);
});

test('contract §9.4: a package state lists the files of a node, and a store search chooses as a library does', async () => {
  const { storedNode } = await import('../lib/state.js');
  const state = { representations: { 'a.md': [{ tag: 'en', default: true }, { tag: 'pt-BR' }, { tag: 'pt-PT' }] } };
  const n = storedNode(state, 'a.md');
  assert.equal(pick(n, 'pt-AO'), 'pt-BR');
  assert.equal(pick(n, ['fr', 'en']), 'default');
  assert.equal(pick(n, 'de'), 'default');
  // A node the state does not list has one file; a state from before 0.8.0 lists none.
  assert.equal(storedNode(state, 'b.md'), null);
  assert.equal(storedNode({}, 'a.md'), null);
  // Entries that are not objects are ignored, never thrown on.
  assert.equal(pick(storedNode({ representations: { 'a.md': [null, 7, { tag: 'en', default: true }] } }, 'a.md'), 'fr'), 'default');
});

test('contract §9.2 step 5.4: the locale chooses among representations the policy keeps, with pushdown too', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readPackage, Library } = await import('../lib/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'moca-retired-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/r', version: '1.0.0', title: 'R', language: 'en', locales: ['fr'] }));
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'content/page.md'), '---\ntype: Note\ntitle: Bread\n---\n\nBread.\n');
  writeFileSync(join(dir, 'content/page.fr.md'), '---\ntype: Note\ntitle: Pain\nstatus: deprecated\n---\n\nBread pain.\n');
  const library = new Library().add(await readPackage(dir));
  rmSync(dir, { recursive: true });
  const hits = library.search('bread', { locale: 'fr' });
  assert.deepEqual(hits.map((r) => r.node.locale), ['en']);
  const all = library.search('bread', { locale: 'fr', includeAll: true });
  assert.deepEqual(all.map((r) => [r.node.locale, r.trust.status]), [['fr', 'deprecated']]);
});

test('contract §9.2 step 5.4: when the default file is not a candidate, the candidate with the lowest tag', () => {
  const n = node('en', 'fr', 'de', 'pt-BR');
  const notDefault = (r) => r.locale !== null;
  assert.equal(pickRepresentation(n, 'es', notDefault).locale, 'de');
  assert.equal(pickRepresentation(n, 'en', notDefault).locale, 'de');
  assert.equal(pickRepresentation(n, 'fr', notDefault).locale, 'fr');
  assert.equal(pickRepresentation(n, 'es', (r) => r.locale === 'pt-BR' || r.locale === 'fr').locale, 'fr');
  assert.equal(pickRepresentation(n, 'es', () => false), undefined);
});

test('contract §9.5: the lexical backend keeps one representation per node unless asked for every one', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readPackage, Library } = await import('../lib/index.js');
  const { LexicalBackend } = await import('../lib/backends/lexical.js');
  const dir = mkdtempSync(join(tmpdir(), 'moca-every-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/e', version: '1.0.0', title: 'E', language: 'en', locales: ['fr'] }));
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'content/page.md'), '---\ntype: Note\ntitle: Bread\n---\n\nBread.\n');
  writeFileSync(join(dir, 'content/page.fr.md'), '---\ntype: Note\ntitle: Pain\n---\n\nBread pain pain.\n');
  const backend = new LexicalBackend(new Library().add(await readPackage(dir)));
  rmSync(dir, { recursive: true });
  assert.equal(backend.search('bread pain', { limit: 10, filters: {} }).length, 1);
  assert.deepEqual(backend.search('bread pain', { limit: 10, filters: { everyRepresentation: true } }).map((h) => h.locale ?? null), ['fr', null]);
});

test('contract §9: localeMode only and first', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readPackage, Library } = await import('../lib/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'moca-mode-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/m', version: '1.0.0', title: 'M', language: 'en', locales: ['fr'] }));
  mkdirSync(join(dir, 'content'));
  // The English-only page matches best; the French page less well.
  writeFileSync(join(dir, 'content/a.md'), '---\ntype: Note\ntitle: A\n---\n\nbread bread bread bread.\n');
  writeFileSync(join(dir, 'content/b.md'), '---\ntype: Note\ntitle: B\n---\n\nbread.\n');
  writeFileSync(join(dir, 'content/b.fr.md'), '---\ntype: Note\ntitle: B\n---\n\nbread pain.\n');
  const library = new Library().add(await readPackage(dir));
  rmSync(dir, { recursive: true });
  assert.deepEqual(library.search('bread', { locale: 'fr' }).map((r) => r.node.path), ['a.md', 'b.md']);
  assert.deepEqual(library.search('bread', { locale: 'fr', localeMode: 'only' }).map((r) => [r.node.path, r.node.locale]), [['b.md', 'fr']]);
  assert.deepEqual(library.search('bread', { locale: 'fr', localeMode: 'first' }).map((r) => r.node.path), ['b.md', 'a.md']);
  assert.deepEqual(library.search('bread', { locale: 'fr', localeMode: 'first', limit: 1 }).map((r) => r.node.path), ['b.md']);
  // Without a locale, localeMode has no effect: each node's best match, as the lexical backend gives it.
  assert.equal(library.search('bread', { localeMode: 'only' }).length, library.search('bread').length);
});

test('package spec §5.3: moca.language, and Reader interface §4: localeCoverage', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readPackage, Library } = await import('../lib/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'moca-nodelang-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/n', version: '1.0.0', title: 'N', language: 'en', locales: ['fr', 'de'] }));
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'content/a.md'), '---\ntype: Note\ntitle: A\n---\n\nA.\n');
  writeFileSync(join(dir, 'content/a.fr.md'), '---\ntype: Note\ntitle: A\nmoca:\n  language: it\n---\n\nA.\n');
  writeFileSync(join(dir, 'content/b.md'), '---\ntype: Note\ntitle: B\nmoca:\n  language: cy\n---\n\nB.\n');
  const result = await readPackage(dir);
  rmSync(dir, { recursive: true });
  assert.deepEqual(result.localeCoverage, { cy: { nodes: 1, of: 2 }, de: { nodes: 0, of: 2 }, en: { nodes: 1, of: 2 }, fr: { nodes: 1, of: 2 } });
  assert.ok(result.diagnostics.some((d) => d.code === 'C005_FIELD_INVALID' && d.file === 'content/a.fr.md'));
  const library = new Library().add(result);
  assert.equal(library.get('https://example.com/n#b.md').node.locale, 'cy');
  assert.equal(library.get('https://example.com/n#b.md', { locale: 'cy' }).node.locale, 'cy');
  assert.equal(library.get('https://example.com/n#a.md', { locale: 'it' }).node.locale, 'en');
});

test('contract §9.4: a package state knows a node in its own language, so a stored record maps to its default file', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readPackage, packageState } = await import('../lib/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'moca-state-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/s', version: '1.0.0', title: 'S', language: 'en' }));
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'content/b.md'), '---\ntype: Note\ntitle: B\nmoca:\n  language: cy\n---\n\nB.\n');
  const state = packageState(await readPackage(dir));
  rmSync(dir, { recursive: true });
  assert.deepEqual(state.nodeLanguages, { 'b.md': 'cy' });
});

test('package spec §5.4: a sibling in another script is not taken when the entry names a script', () => {
  const n = node('en', 'zh-Hans', 'sr-Cyrl', 'zh-Hant-HK');
  assert.equal(pick(n, ['zh-Hant-TW', 'en']), 'zh-Hant-HK');
  assert.equal(pick(node('en', 'zh-Hans'), ['zh-Hant-TW', 'en']), 'default');
  assert.equal(pick(n, ['sr-Latn', 'en']), 'default');
  assert.equal(pick(n, 'zh'), 'zh-Hans');
  assert.equal(pick(n, 'zh-TW'), 'zh-Hans');
});

test('package spec §5.4: a list keeps 16 entries of at most 35 characters', async () => {
  const { trimmedLocales } = await import('../lib/locale.js');
  const many = Array.from({ length: 20 }, (_, i) => `x${i}`);
  assert.deepEqual(trimmedLocales(many), { list: many.slice(0, 16), dropped: 4 });
  assert.deepEqual(trimmedLocales([`a-${'b'.repeat(34)}`, 'fr']), { list: ['fr'], dropped: 1 });
  assert.deepEqual(trimmedLocales(`a-${'b'.repeat(33)}`), { list: [`a-${'b'.repeat(33)}`], dropped: 0 });
  assert.deepEqual(trimmedLocales(['', 7, 'en']), { list: ['en'], dropped: 0 });
});

test('contract §9.2: localeMode first is bounded when the host set no bound, and says so (S010)', async () => {
  const { Search, FIRST_BOUND } = await import('../lib/search.js');
  let asked = 0;
  const record = (i) => ({ package: { digest: 'd', id: 'https://example.com/p' }, node: { ref: `r${i}`, path: `p${i}.md`, locale: 'en' }, trust: { inForce: true, superseded: false, status: 'stable' }, score: 1 });
  const backend = { features: [], search: (q, { limit }) => { asked = Math.max(asked, limit); return Array.from({ length: limit }, (_, i) => ({ digest: 'd', node: `n${i}`, path: `p${i}.md`, score: 1, record: record(i) })); } };
  const search = new Search({ packages: [{ digest: 'd', id: 'https://example.com/p', version: '1.0.0', signers: [], relations: [] }], clock: () => new Date('2026-11-28T00:00:00Z') }, { backend });
  await search.search('q', { locale: 'fr', localeMode: 'first', limit: 5 });
  assert.equal(asked, FIRST_BOUND);
  assert.ok(search.diagnostics.some((d) => d.code === 'S010_SEARCH_TRUNCATED'));
});
