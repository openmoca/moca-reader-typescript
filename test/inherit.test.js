import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackage, Library } from '../lib/index.js';

const ID = 'https://example.com/t';
function makePackage(files) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-inherit-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: ID, version: '1.0.0', title: 'T', language: 'en', locales: ['fr'] }));
  writeFileSync(join(dir, 'structure.ttl'), `<${ID}#topic> a <http://www.w3.org/2004/02/skos/core#Concept> .\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const page = (front) => `---\ntype: Note\ntitle: A\n${front}---\n\nText.\n`;
const recordOf = (library, locale) => library.get(`${ID}#a.md`, { locale });

async function load(files) {
  const dir = makePackage(files);
  const result = await readPackage(dir);
  rmSync(dir, { recursive: true });
  return { result, library: new Library({ clock: () => new Date('2026-11-28T00:00:00Z') }).add(result) };
}

test('package spec §5.4: a translation with none of the keys takes each from its default file', async () => {
  const { library } = await load({
    'content/a.md': page(`status: deprecated\nmoca:\n  valid_from: 2026-01-01T00:00:00Z\n  valid_until: 2027-01-01T00:00:00Z\n  concepts:\n    - iri: ${ID}#topic\n`),
    'content/a.fr.md': page(''),
  });
  const fr = recordOf(library, 'fr');
  assert.equal(fr.node.locale, 'fr');
  assert.equal(fr.trust.status, 'deprecated');
  assert.equal(fr.trust.validFrom, '2026-01-01T00:00:00Z');
  assert.equal(fr.trust.validUntil, '2027-01-01T00:00:00Z');
  assert.deepEqual(fr.concepts, [`${ID}#topic`]);
});

test('package spec §5.4: each key on its own; a key the translation writes is its own, even when invalid', async () => {
  const { library } = await load({
    'content/a.md': page(`status: deprecated\nmoca:\n  valid_until: 2027-01-01T00:00:00Z\n  concepts:\n    - iri: ${ID}#topic\n`),
    'content/a.fr.md': page('status: retired\nmoca:\n  valid_from: 2026-06-01T00:00:00Z\n  concepts: []\n'),
  });
  const fr = recordOf(library, 'fr');
  assert.equal(fr.trust.status, 'stable');
  assert.equal(fr.trust.validFrom, '2026-06-01T00:00:00Z');
  assert.equal(fr.trust.validUntil, '2027-01-01T00:00:00Z');
  assert.equal(fr.concepts, undefined);
});

test('package spec §5.4: C010 on the window a translation ends up with, on its own file', async () => {
  const { result } = await load({
    'content/a.md': page('moca:\n  valid_until: 2026-01-01T00:00:00Z\n'),
    'content/a.fr.md': page('moca:\n  valid_from: 2026-06-01T00:00:00Z\n'),
  });
  const c010 = result.diagnostics.filter((d) => d.code === 'C010_VALIDITY_WINDOW_INVALID').map((d) => d.file);
  assert.deepEqual(c010, ['content/a.fr.md']);
});
