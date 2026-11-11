import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackage, Library, validateAgainst, structureView } from '../lib/index.js';

const repo = process.env.MOCA_SPEC_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'moca-spec');
const HEAD = '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n@prefix dct: <http://purl.org/dc/terms/> .\n@prefix x: <https://example.org/x#> .\n';
const TTL = `${HEAD}x:A a skos:Concept ; skos:prefLabel "A"@en .\nx:B a skos:Concept ; dct:requires x:A .\n`;
const codes = (r) => r.diagnostics.map((d) => d.code);

function makePackage({ ttl = TTL, concepts = ['https://example.org/x#A'], files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-structure-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/s', version: '1.0.0', title: 'S' }));
  mkdirSync(join(dir, 'content'));
  if (ttl !== null) writeFileSync(join(dir, 'structure.ttl'), ttl);
  for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, p), t);
  const bindings = concepts.map((iri) => `    - iri: ${JSON.stringify(iri)}`).join('\n');
  const moca = concepts.length > 0 ? `moca:\n  concepts:\n${bindings}\n` : '';
  writeFileSync(join(dir, 'content/a.md'), `---\ntype: Note\ntitle: A\n${moca}---\n\n# A\n`);
  return dir;
}

test('the examples are structured, and citation records carry their concepts', async () => {
  for (const dir of ['examples/service-catalogue', 'examples/handbook/incident-response']) {
    const pkg = await readPackage(join(repo, dir));
    assert.deepEqual(codes(pkg), []);
    assert.deepEqual(pkg.capabilities, ['core', 'structured']);
    const records = new Library().add(pkg).citations();
    assert.ok(records.every((r) => r.concepts?.length > 0));
    for (const r of records) assert.deepEqual(validateAgainst('citationRecord', r), []);
    assert.deepEqual(validateAgainst('structure', structureView(pkg.structure.graph)), []);
  }
});

test('inverse terms normalise, and ordered collections keep their order', async () => {
  const ttl = `${HEAD}x:A a skos:Concept ; skos:narrower x:B ; dct:isPartOf x:W .\nx:B a skos:Concept ; dct:isRequiredBy x:C .\nx:C a skos:Concept ; dct:isReplacedBy x:D .\nx:D a skos:Concept .\nx:W a skos:Concept .\nx:Seq a skos:OrderedCollection ; skos:memberList ( x:C x:A x:B ) .\n`;
  const pkg = await readPackage(makePackage({ ttl }));
  assert.deepEqual(codes(pkg), []);
  const view = structureView(pkg.structure.graph);
  const by = Object.fromEntries(view.concepts.map((c) => [c.iri.split('#')[1], c]));
  assert.deepEqual(by.B.broader, ['https://example.org/x#A']);
  assert.deepEqual(by.W.parts, ['https://example.org/x#A']);
  assert.deepEqual(by.C.requires, ['https://example.org/x#B']);
  assert.deepEqual(by.D.replaces, ['https://example.org/x#C']);
  assert.deepEqual(view.sequences[0].members.map((m) => m.split('#')[1]), ['C', 'A', 'B']);
});

test('structure problems are warnings that withhold only the structured capability', async () => {
  const cases = [
    [{ ttl: 'this is not turtle' }, 'O001_ONTOLOGY_UNPARSEABLE'],
    [{ ttl: null }, 'O002_CONCEPT_UNDECLARED'],
    [{ concepts: ['https://example.org/x#Z'] }, 'O002_CONCEPT_UNDECLARED'],
    [{ ttl: `${TTL}x:B dct:requires x:Missing .\n` }, 'O002_CONCEPT_UNDECLARED'],
    [{ ttl: `${TTL}<https://example.org/x> <http://www.w3.org/2002/07/owl#imports> <https://example.org/other> .\n` }, 'O003_REMOTE_REFERENCE'],
    [{ ttl: `${TTL}<relative> a skos:Concept .\n` }, 'O003_REMOTE_REFERENCE'],
    [{ concepts: ['x:A'] }, 'O003_REMOTE_REFERENCE'],
    [{ ttl: `${TTL}x:A dct:requires x:B .\n` }, 'O005_STRUCTURE_CYCLE'],
  ];
  for (const [options, code] of cases) {
    const pkg = await readPackage(makePackage(options));
    assert.ok(codes(pkg).includes(code), `${JSON.stringify(options).slice(0, 80)} -> ${codes(pkg)}`);
    assert.equal(pkg.valid, true);
    assert.deepEqual(pkg.capabilities, ['core']);
  }
});

test('a package without structure is complete, and only unknown predicates are ignored', async () => {
  const plain = makePackage({ ttl: null, concepts: [] });
  const pkg = await readPackage(plain);
  assert.deepEqual(codes(pkg), []);
  assert.equal(pkg.structure.present, false);
  const extra = await readPackage(makePackage({ ttl: `${TTL}x:A <https://example.org/vocab#objective> "Understand A" .\n` }));
  assert.deepEqual(extra.capabilities, ['core', 'structured']);
});

test('structure files over the size or triple limits are refused', async () => {
  const pkg = await readPackage(makePackage(), { limits: { maxTriples: 2 } });
  assert.ok(codes(pkg).includes('O001_ONTOLOGY_UNPARSEABLE'));
  const big = await readPackage(makePackage(), { limits: { maxStructureBytes: 10 } });
  assert.ok(codes(big).includes('O001_ONTOLOGY_UNPARSEABLE'));
});

test('structure.json is an ordinary file: no Reader checks it (moca-spec ADR-0019, O004 retired)', async () => {
  const pkg = await readPackage(makePackage({ files: { 'structure.json': '{"not":"a view"}' } }));
  assert.equal(pkg.valid, true);
  assert.ok(!codes(pkg).some((c) => c.startsWith('O')), codes(pkg).join(','));
});
