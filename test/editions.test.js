import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompositionIndex } from '../lib/composition.js';
import { chooseEdition } from '../lib/editions.js';

// A course composite whose two editions are composites of lessons, both composing one shared handout.
const composition = {
  members: [
    { digest: 'd-en', id: 'https://example.com/en', direct: true, language: 'en', bound: true, nodes: [], parents: [] },
    { digest: 'd-fr', id: 'https://example.com/fr', direct: true, language: 'fr', bound: true, nodes: [], parents: [] },
    { digest: 'd-en-1', id: 'https://example.com/en/1', bound: false, nodes: [], parents: ['d-en'] },
    { digest: 'd-fr-1', id: 'https://example.com/fr/1', bound: false, nodes: [], parents: ['d-fr'] },
    { digest: 'd-handout', id: 'https://example.com/handout', bound: false, nodes: [], parents: ['d-en', 'd-fr'] },
  ],
  up: {},
  slots: [{ iri: 'https://example.com/course#c', editions: ['https://example.com/en', 'https://example.com/fr'], default: 'https://example.com/en' }],
};
const index = new CompositionIndex([{ digest: 'd-course', composition }]);
const keeps = (digest, locale) => index.composersOf(digest).every((c) => c.keepsEdition({ package: { digest } }, locale));

test('package spec §7.4: the chosen edition and its members are kept, the other edition and its members are not', () => {
  assert.equal(keeps('d-fr', 'fr'), true);
  assert.equal(keeps('d-fr-1', 'fr'), true);
  assert.equal(keeps('d-en', 'fr'), false);
  assert.equal(keeps('d-en-1', 'fr'), false);
});

test('package spec §7.4: a member shared by two editions is the chosen one\'s too', () => {
  assert.equal(keeps('d-handout', 'fr'), true);
  assert.equal(keeps('d-handout', 'en'), true);
});

test('package spec §7.4: choosing by lookup, then the default, then the lowest id', () => {
  const slot = { editions: ['https://example.com/b', 'https://example.com/a', 'https://example.com/c'], default: 'https://example.com/c' };
  const available = new Map([['https://example.com/a', { language: 'pt-PT' }], ['https://example.com/b', { language: 'pt-BR' }], ['https://example.com/c', { language: 'en' }]]);
  assert.equal(chooseEdition(slot, available, 'pt-AO'), 'https://example.com/b');
  assert.equal(chooseEdition(slot, available, 'de'), 'https://example.com/c');
  available.delete('https://example.com/c');
  assert.equal(chooseEdition(slot, available, 'de'), 'https://example.com/a');
  assert.equal(chooseEdition(slot, new Map(), 'de'), undefined);
});

test('package spec §7.4: an edition the composite lists itself can be chosen though another member also composes it', () => {
  const nested = {
    members: [
      { digest: 'd-en', id: 'https://example.com/en', direct: true, language: 'en', bound: true, nodes: [], parents: [] },
      { digest: 'd-fr', id: 'https://example.com/fr', direct: true, language: 'fr', bound: true, nodes: [], parents: ['d-en'] },
    ],
    up: {},
    slots: [{ iri: 'https://example.com/course#c', editions: ['https://example.com/en', 'https://example.com/fr'], default: 'https://example.com/en' }],
  };
  const [composer] = new CompositionIndex([{ digest: 'd-course', composition: nested }]).composersOf('d-fr');
  assert.deepEqual([...composer.slots[0].available.keys()].sort(), ['https://example.com/en', 'https://example.com/fr']);
  assert.equal(composer.keepsEdition({ package: { digest: 'd-fr' } }, 'fr'), true);
});

test('package spec §7.4: a slot belongs to the composite whose namespace holds its IRI', async () => {
  const { ownsSlot } = await import('../lib/editions.js');
  assert.equal(ownsSlot('https://example.com/course', 'https://example.com/course#bread'), true);
  assert.equal(ownsSlot('https://example.com/course', 'https://example.com/course/bread'), true);
  assert.equal(ownsSlot('https://example.com/course', 'https://example.com/course-b#bread'), false);
  assert.equal(ownsSlot('https://example.com/course', 'https://example.com/other#bread'), false);
  assert.equal(ownsSlot(undefined, 'https://example.com/course#bread'), false);
});

test('package spec §7.4, "Display": SemVer precedence picks the version that answers', async () => {
  const { compareSemver } = await import('../lib/editions.js');
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareSemver('1.0.0+build.2', '1.0.0+build.1'), 0);
});

test('package spec §7.4, "Choosing": a file summary says whether a package can return a record', async () => {
  const { fileKept, summaryPasses, packageInForce } = await import('../lib/availability.js');
  const now = new Date('2026-11-28T00:00:00Z');
  const o = { now, superseded: false, includeAll: false };
  assert.equal(fileKept({ status: 'stable' }, o), true);
  assert.equal(fileKept({ status: 'deprecated' }, o), false);
  assert.equal(fileKept({ status: 'stable', validUntil: '2026-01-01T00:00:00Z' }, o), false);
  assert.equal(fileKept({ status: 'stable' }, { ...o, superseded: true }), false);
  assert.equal(fileKept({ status: 'deprecated' }, { ...o, includeAll: true }), true);
  assert.equal(fileKept({ status: 'stable', audience: 'staff' }, { ...o, audiences: ['public'] }), false);
  assert.equal(summaryPasses([{ status: 'deprecated' }, { status: 'stable' }], o), true);
  assert.equal(summaryPasses([{ status: 'stable', path: 'a.md' }], o, (path) => path !== 'a.md'), false);
  assert.equal(summaryPasses(undefined, o), true);
  assert.equal(packageInForce(undefined, '2026-01-01T00:00:00Z', now), false);
  assert.equal(packageInForce('2026-12-01T00:00:00Z', undefined, now), false);
  // A window whose end is not after its start is ignored, as for a node.
  assert.equal(packageInForce('2026-12-01T00:00:00Z', '2026-01-01T00:00:00Z', now), true);
});
