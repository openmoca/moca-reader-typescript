import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackage, Library, Search, LexicalBackend, ontologyGuided, validateAgainst } from '../lib/index.js';

const repo = process.env.MOCA_SPEC_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'moca-spec');
const IR = 'https://example.org/handbook/incident#';
const SVC = 'https://example.org/services#';
const short = (items) => items.map((x) => x.iri.split('#')[1]);
const ORG = `@prefix dct: <http://purl.org/dc/terms/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ir: <${IR}> .
ir:ResolveAndReview dct:requires ir:DeclareIncident .
ir:LegalHold a skos:Concept ; skos:prefLabel "Legal hold"@en ; skos:broader ir:ResolveAndReview .
`;

async function library(options = {}) {
  const lib = new Library(options);
  for (const d of ['examples/handbook/incident-response', 'examples/service-catalogue']) lib.add(await readPackage(join(repo, d)));
  return lib;
}

test('structure operations answer from the package structure', async () => {
  const s = (await library()).structure;
  assert.equal(s.concept(`${IR}NotifyCustomers`).label, 'Notify customers');
  assert.equal(s.concept(`${IR}Nope`), null);
  assert.deepEqual(short(s.requires(`${IR}NotifyCustomers`)), ['AssessSeverity']);
  assert.deepEqual(short(s.requiredBy(`${IR}AssessSeverity`)), ['DeclareIncident', 'NotifyCustomers']);
  assert.deepEqual(short(s.parts(`${IR}IncidentResponse`)), ['AssessSeverity', 'DeclareIncident', 'NotifyCustomers', 'ResolveAndReview']);
  assert.deepEqual(short(s.sequence(`${IR}ResponseSteps`)), ['AssessSeverity', 'DeclareIncident', 'NotifyCustomers', 'ResolveAndReview']);
  assert.equal(s.sequence(`${IR}NotifyCustomers`), null);
  assert.deepEqual(short(s.narrower(`${SVC}Microservice`)), ['OrderService']);
  assert.deepEqual(short(s.related(`${SVC}ServiceBoundary`)), ['Microservice']);
  const nodes = s.nodes(`${IR}IncidentResponse`, { include: 'parts' });
  assert.deepEqual(nodes.map((r) => r.node.path), ['incident-response.md', 'steps/assess-severity.md', 'steps/declare-incident.md', 'steps/notify-customers.md', 'steps/resolve-and-review.md']);
  for (const r of nodes) assert.deepEqual(validateAgainst('citationRecord', r), []);
});

test('overlays add to the structure, and every fact names its layer', async () => {
  const s = (await library({ overlays: [{ id: 'acme', layer: 'organisation', source: ORG }] })).structure;
  const req = s.requires(`${IR}ResolveAndReview`, { transitive: true });
  assert.deepEqual(short(req), ['AssessSeverity', 'DeclareIncident']);
  assert.deepEqual(req.map((r) => r.layer), ['package', 'organisation']);
  assert.equal(s.concept(`${IR}LegalHold`).layer, 'organisation');
  assert.deepEqual(short(s.narrower(`${IR}ResolveAndReview`)), ['LegalHold']);
  // The package's own statements are unchanged.
  assert.deepEqual(short(s.requires(`${IR}NotifyCustomers`)), ['AssessSeverity']);
  assert.equal(s.concept(`${IR}NotifyCustomers`).layer, 'package');
});

test('overlay problems are reported on the library and never throw', async () => {
  const lib = new Library({ overlays: [{ id: 'bad', layer: 'application', source: 'not turtle' }] });
  assert.deepEqual(lib.diagnostics.items.map((d) => d.code), ['O001_ONTOLOGY_UNPARSEABLE']);
  assert.throws(() => new Library({ overlays: [{ id: 'x', layer: 'package', source: '' }] }), /layer/);
});

test('search with a scope returns only nodes bound to the concept or its descendants', async () => {
  const lib = await library();
  const search = new Search(lib, { backend: new LexicalBackend(lib) });
  const scoped = await search.search('customers severity incident', { scope: `${IR}NotifyCustomers`, limit: 10 });
  assert.deepEqual(scoped.map((r) => r.node.path), ['steps/notify-customers.md']);
  const whole = await search.search('customers severity incident', { scope: `${IR}IncidentResponse`, limit: 10 });
  assert.ok(whole.length >= 3);
  assert.ok(whole.every((r) => r.package.id.endsWith('incident-response')));
});

test('the default ontology-guided strategy adds required material, tagged', async () => {
  const lib = await library();
  const search = new Search(lib, { backend: new LexicalBackend(lib), hooks: ontologyGuided() });
  const results = await search.search('when do we notify customers');
  assert.deepEqual(results.map((r) => [r.node.path, r.retrieval.via]), [['steps/notify-customers.md', 'search'], ['steps/assess-severity.md', 'requires']]);
  for (const r of results) assert.deepEqual(validateAgainst('citationRecord', r), []);
});

test('a hostile egress hook cannot return what the gate excludes', async () => {
  const lib = new Library();
  for (const p of ['examples/policy-corpus/retention-2025', 'examples/policy-corpus/retention-2026', 'examples/support-kb']) lib.add(await readPackage(join(repo, p)));
  const everything = lib.citations({ includeText: true });
  const fake = { ...everything[0], package: { ...everything[0].package, digest: `sha256:${'0'.repeat(64)}` } };
  const hostile = { egress: () => [...everything, fake, { not: 'a record' }] };
  const search = new Search(lib, { backend: new LexicalBackend(lib), audiences: ['public'], hooks: hostile });
  const results = await search.search('anything', { limit: 50 });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.trust.inForce && !r.trust.superseded && r.trust.status !== 'deprecated'));
  assert.ok(results.every((r) => !r.audience || r.audience === 'public'));
  assert.ok(results.every((r) => r.package.digest !== fake.package.digest));
  // The caller's scope binds the gate even when a hook adds content outside it.
  const scoped = await search.search('anything', { concepts: ['https://example.org/none#X'] });
  assert.deepEqual(scoped, []);
});
