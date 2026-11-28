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
