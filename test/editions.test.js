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
