// Limits and fail-closed rules: Reader contract §3, §5 and §15; attestations §6 and §7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import {
  readPackage, archiveSource, createEnvelope, verifyEnvelope, packageStatement, parseStructure, StructureGraph, Diagnostics,
  Library, Search, LexicalBackend, DEFAULT_LIMITS, PAYLOAD_TYPE, bindSidecar,
} from '../lib/index.js';
import { sigstoreIdentityFor, verifySignature, loadTrustRoot } from '../lib/attestations.js';
import { MAX_SIGNATURES } from '../lib/dsse.js';
import { resolveAi, resolveExport, gateReasons, ratingOf, recordTerms } from '../lib/terms.js';
import { linkTargets } from '../lib/content.js';
import { markdownText, htmlText } from '../lib/evidence-text.js';

const ID = 'https://example.com/publisher-a/handbook';
const NODE = '---\ntype: Note\ntitle: A\nmoca:\n  audience: public\n---\n\n# A\n\nThe lantern keeper.\n';
const codes = (r) => r.diagnostics.map((d) => d.code);

function makePackage(manifest, files = { 'content/a.md': NODE }) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-limits-'));
  writeFileSync(join(dir, 'moca.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}

/** A package signed by `keys` under the keyid `k`, with `extra` signature entries before the real one. */
async function signedPackage(keys, { id = ID, extra = 0 } = {}) {
  const dir = makePackage({ id, version: '1.0.0', title: 'T' });
  const { digest } = await readPackage(dir);
  const envelope = createEnvelope({ payload: Buffer.from(JSON.stringify(packageStatement({ id, version: '1.0.0', digest }))), payloadType: PAYLOAD_TYPE, privateKeyPem: keys.privateKeyPem, keyid: 'k' });
  envelope.signatures = [...Array.from({ length: extra }, (_, i) => ({ keyid: `other-${i}`, sig: Buffer.alloc(64).toString('base64') })), ...envelope.signatures];
  mkdirSync(join(dir, 'attestations'));
  writeFileSync(join(dir, 'attestations', 'package.k.dsse.json'), JSON.stringify(envelope));
  return dir;
}
const trustRootFor = (keys, more = {}) => ({ keys: [{ keyid: 'k', publicKey: keys.publicKeyPem, roles: ['package'], ...more }] });

// --- Sigstore identities are compared exactly (attestations §6) ---

test('a Sigstore identity matches only when issuer and subject are each equal, as whole strings', () => {
  const issuer = 'https://token.actions.githubusercontent.com';
  const subject = 'https://github.com/acme/kb/.github/workflows/publish.yml@refs/heads/main';
  const email = { issuer: 'https://accounts.google.com', subject: 'sam.ortiz@acme.example' };
  const identities = [{ issuer, subject, roles: ['package'] }, { ...email, roles: ['package'] }];
  assert.equal(sigstoreIdentityFor(identities, issuer, subject), identities[0]);
  assert.equal(sigstoreIdentityFor(identities, email.issuer, email.subject), identities[1]);
  const different = [
    [issuer, `${subject}-next`],
    [issuer, `prefix-${subject}`],
    [issuer, subject.slice(0, -1)],
    [issuer, subject.toUpperCase()],
    [issuer, subject.replace('.github', 'xgithub')],
    [`${issuer}.example`, subject],
    [issuer.slice(0, -1), subject],
    [email.issuer, 'sam.ortiz@acme.example.org'],
    [email.issuer, 'samxortiz@acme.example'],
    [email.issuer, 'Sam.Ortiz@acme.example'],
    [issuer, email.subject],
    [undefined, subject],
    [issuer, undefined],
  ];
  for (const [i, s] of different) assert.equal(sigstoreIdentityFor(identities, i, s), undefined, `${i} ${s}`);
  // A subject is text: characters that mean something in a pattern mean nothing here.
  assert.equal(sigstoreIdentityFor([{ issuer, subject: '.*' }], issuer, subject), undefined);
  assert.equal(sigstoreIdentityFor([{ issuer, subject: '' }], issuer, subject), undefined);
});

// --- Offline is the default, and offline makes no request (attestations §6, contract §4) ---

test('offline Sigstore verification opens no connection and writes no cache', async () => {
  const connects = [];
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    connects.push(args);
    return original.apply(this, args);
  };
  const cache = join(mkdtempSync(join(tmpdir(), 'moca-tuf-')), 'cache');
  try {
    const trustRoot = loadTrustRoot({ sigstore: { identities: [{ issuer: 'https://issuer.example', subject: 'a@example.com', roles: ['package'] }] } });
    const parsed = { format: 'sigstore', container: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' } };
    const result = await verifySignature(parsed, trustRoot, 'package', { tufCachePath: cache });
    // The library's own copy of the public-good trusted root was used: the bundle was reached, and refused.
    assert.equal(result.outcome, 'invalid');
    assert.match(result.reason, /not a valid Sigstore bundle/);
  } finally {
    net.Socket.prototype.connect = original;
  }
  assert.deepEqual(connects, []);
  assert.equal(existsSync(cache), false);
});

// --- Signatures and attestation files are bounded (contract §3, attestations §7) ---

test('an envelope with more than 16 signature entries is malformed, and none is tried', async () => {
  const keys = keyPair();
  assert.equal(MAX_SIGNATURES, 16);
  const atLimit = await readPackage(await signedPackage(keys, { extra: 15 }), { trustRoot: trustRootFor(keys) });
  assert.deepEqual(codes(atLimit), []);
  assert.equal(atLimit.capabilities.includes('signed'), true);
  const over = await readPackage(await signedPackage(keys, { extra: 16 }), { trustRoot: trustRootFor(keys) });
  assert.deepEqual(codes(over), ['A001_ATTESTATION_MALFORMED']);
  assert.equal(over.capabilities.includes('signed'), false);

  const envelope = createEnvelope({ payload: Buffer.from('{}'), payloadType: PAYLOAD_TYPE, privateKeyPem: keys.privateKeyPem, keyid: 'k' });
  let asked = 0;
  const resolvePublicKey = () => {
    asked += 1;
    return keys.publicKeyPem;
  };
  const many = { ...envelope, signatures: [...Array.from({ length: 16 }, () => ({ keyid: 'k', sig: Buffer.alloc(64).toString('base64') })), ...envelope.signatures] };
  assert.equal(verifyEnvelope({ envelope: many, resolvePublicKey }).ok, false);
  assert.equal(asked, 0);
});

test('attestation files are bounded in number and in size (A001)', async () => {
  const keys = keyPair();
  assert.equal(DEFAULT_LIMITS.maxAttestations, 256);
  assert.equal(DEFAULT_LIMITS.maxAttestationBytes, 1024 * 1024);
  const dir = await signedPackage(keys);
  writeFileSync(join(dir, 'attestations', 'package.other.dsse.json'), '{}');
  const tooMany = await readPackage(dir, { trustRoot: trustRootFor(keys), limits: { maxAttestations: 1 } });
  assert.deepEqual(codes(tooMany), ['A001_ATTESTATION_MALFORMED']);
  assert.deepEqual(tooMany.attestations, []);
  assert.deepEqual(tooMany.signers, []);
  const tooLarge = await readPackage(await signedPackage(keys), { trustRoot: trustRootFor(keys), limits: { maxAttestationBytes: 32 } });
  assert.deepEqual(codes(tooLarge), ['A001_ATTESTATION_MALFORMED']);
  assert.deepEqual(tooLarge.signers, []);
});

// --- A signer's ids cover the package (attestations §6) ---

test('a signer with ids signs only the packages those ids cover (A010)', async () => {
  const keys = keyPair();
  const dir = await signedPackage(keys);
  const read = (more) => readPackage(dir, { trustRoot: trustRootFor(keys, more) });
  for (const ids of [undefined, [ID], ['https://example.com/publisher-a/'], ['https://example.com/other/', ID]]) {
    const result = await read(ids ? { ids } : {});
    assert.deepEqual(codes(result), [], JSON.stringify(ids));
    assert.equal(result.capabilities.includes('signed'), true, JSON.stringify(ids));
    assert.equal(result.signers.length, 1);
  }
  // Not covered: another publisher's prefix, a prefix with no boundary, an id that only starts the same, an empty list.
  for (const ids of [['https://example.com/publisher-b/'], ['https://example.com/publisher-a'], [`${ID}-2`], []]) {
    const result = await read({ ids });
    assert.deepEqual(codes(result), ['A010_SIGNER_NOT_FOR_PACKAGE'], JSON.stringify(ids));
    assert.equal(result.valid, true);
    assert.equal(result.capabilities.includes('signed'), false);
    assert.deepEqual(result.signers, []);
    assert.equal(result.attestations[0].outcome, 'invalid');
    assert.equal(result.terms.authority, 'unverified');
  }
  const required = await readPackage(dir, { trustRoot: trustRootFor(keys, { ids: ['https://example.com/publisher-b/'] }), requireSignature: true });
  assert.equal(required.valid, false);
  assert.deepEqual(codes(required).sort(), ['A009_SIGNATURE_REQUIRED', 'A010_SIGNER_NOT_FOR_PACKAGE']);
});

// --- Structure work is bounded (contract §3) ---

function sharedList(collections, length) {
  const lines = ['@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .', '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .', '@prefix c: <https://example.org/c#> .'];
  for (let i = 0; i < collections; i++) lines.push(`c:P${i} skos:memberList _:l0 .`);
  for (let i = 0; i < length; i++) lines.push(`_:l${i} rdf:first c:M${i} ; rdf:rest ${i + 1 < length ? `_:l${i + 1}` : 'rdf:nil'} .`);
  return lines.join('\n');
}
const parse = (ttl, maxTriples) => {
  const diagnostics = new Diagnostics();
  const parsed = parseStructure(ttl, { file: 'structure.ttl', layer: 'package', origin: 'o', diagnostics, limits: { ...DEFAULT_LIMITS, maxTriples } });
  return { ...parsed, codes: diagnostics.items.map((d) => d.code) };
};

test('collections that share a member list each get its members, and their total is bounded (O001)', () => {
  // 10 collections, one list of 10: 30 triples, 100 members.
  const within = parse(sharedList(10, 10), 100);
  assert.deepEqual(within.codes, []);
  const graph = new StructureGraph(within.facts);
  const expected = Array.from({ length: 10 }, (_, i) => `https://example.org/c#M${i}`);
  for (let i = 0; i < 10; i++) assert.deepEqual(graph.collections.get(`https://example.org/c#P${i}`).members, expected);
  const over = parse(sharedList(10, 10), 99);
  assert.deepEqual(over.codes, ['O001_ONTOLOGY_UNPARSEABLE']);
  assert.deepEqual(over.facts, []);
  assert.equal(over.ok, false);
});

test('a structure file inside the default limits never yields more member facts than the triple limit', () => {
  // 600 collections sharing 600 cells: 1,800 triples that would be 360,000 members.
  const started = performance.now();
  const result = parse(sharedList(600, 600), DEFAULT_LIMITS.maxTriples);
  assert.deepEqual(result.codes, ['O001_ONTOLOGY_UNPARSEABLE']);
  assert.ok(performance.now() - started < 2000);
});

test('one long member list is indexed in time proportional to its length', () => {
  const facts = Array.from({ length: 100_000 }, (_, index) => ({ s: 'https://example.org/c#P', kind: 'member', o: `https://example.org/c#M${index}`, index, layer: 'package', origin: 'o' }));
  const started = performance.now();
  const graph = new StructureGraph(facts);
  assert.equal(graph.collections.get('https://example.org/c#P').members.length, 100_000);
  assert.ok(performance.now() - started < 2000);
});

// --- The terms gate fails closed (contract §15.3, §15.4) ---

const resolved = (terms, path = 'a.md') => resolveAi({ terms, authority: 'unverified' }, path);
const allStrictest = (ai) => {
  for (const field of ['device', 'host', 'provider', 'training', 'machineTranslation']) assert.equal(ai[`allowed.${field}`].value, false, field);
  assert.equal(ai.answerSources.value, 'work');
};

test('a malformed container in terms makes every permission under it the strictest', () => {
  for (const allowed of [false, true, 'none', null, 5, []]) {
    const ai = resolved({ ai: { allowed } });
    for (const field of ['device', 'host', 'provider', 'training', 'machineTranslation']) assert.equal(ai[`allowed.${field}`].value, false, `${JSON.stringify(allowed)} ${field}`);
    assert.equal(ai.answerSources.value, 'model');
    assert.deepEqual(gateReasons({ ai: { destination: 'device', use: 'answer' } }, ai, null), ['ai.allowed.device']);
  }
  for (const container of ['none', false, null, 7, []]) {
    const ai = resolved({ ai: container });
    allStrictest(ai);
    // The conditions cannot be met, whatever the host offers.
    assert.equal(ai.providerRequires.value.length, 1);
  }
  // An absent container sets nothing.
  assert.equal(resolved({})['allowed.provider'].value, true);
  assert.equal(resolved({ ai: {} })['allowed.provider'].value, true);
  assert.equal(resolved({ ai: { allowed: {} } })['allowed.provider'].value, true);
});

test('a nodes value or entry that does not say which nodes it means counts for every node', () => {
  for (const nodes of [{}, { paths: ['content/a.md'] }, 'content/a.md', null, ['content/a.md'], [null], [{ ai: { allowed: { provider: false } } }], [{ paths: 'content/a.md' }], [{ paths: [1] }]]) {
    for (const path of ['a.md', 'b.md']) {
      allStrictest(resolved({ nodes }, path));
      assert.notEqual(ratingOf({ nodes }, path), null, JSON.stringify(nodes));
    }
  }
  // A malformed container inside a well-formed entry reaches that entry's nodes only.
  const terms = { nodes: [{ paths: ['content/a.md'], ai: { allowed: false } }] };
  assert.equal(resolved(terms, 'a.md')['allowed.device'].value, false);
  assert.equal(resolved(terms, 'b.md')['allowed.device'].value, true);
});

test('a malformed rights or rights.export container does not allow export', () => {
  const exportOf = (terms) => resolveExport({ terms }).value;
  assert.equal(exportOf({}), true);
  assert.equal(exportOf({ rights: {} }), true);
  assert.equal(exportOf({ rights: { export: { allowed: true } } }), true);
  for (const rights of [false, 'all', null, [], { export: false }, { export: 'yes' }, { export: null }, { export: { allowed: 'yes' } }]) {
    assert.equal(exportOf({ rights }), false, JSON.stringify(rights));
  }
});

const ai = resolved({});
const rating = (request, value) => gateReasons({ rating: request }, ai, value);

test('a record rated only under a scheme the host did not list is unrated for that filter', () => {
  const other = { contentRating: [{ scheme: 'other-scheme', value: '18' }] };
  assert.deepEqual(rating({ schemes: { 'example-scheme': ['PG'] } }, other), ['rating.unrated']);
  assert.deepEqual(rating({ explicit: false }, other), ['rating.unrated']);
  assert.deepEqual(rating({ schemes: { 'example-scheme': ['PG'] }, allowUnrated: true }, other), []);
  assert.deepEqual(rating({ schemes: { 'other-scheme': ['18'] } }, other), []);
  assert.deepEqual(rating({ schemes: { 'other-scheme': ['12'] } }, other), ['rating.other-scheme']);
  // An explicit value rates a record; a listed scheme it has no entry under then removes nothing.
  assert.deepEqual(rating({ explicit: false, schemes: { 'example-scheme': ['PG'] } }, { ...other, explicit: false }), []);
  assert.deepEqual(rating({ explicit: false }, null), ['rating.unrated']);
});

test('a malformed rating counts as the strictest', () => {
  for (const value of ['clean', false, 5, []]) {
    assert.deepEqual(rating({ explicit: false, allowUnrated: true }, value), ['rating.explicit'], JSON.stringify(value));
    assert.deepEqual(rating({ schemes: { 'example-scheme': ['PG'] }, allowUnrated: true }, value), ['rating.example-scheme']);
    assert.deepEqual(recordTerms('unverified', ai, value).rating, { explicit: true });
  }
  assert.equal(ratingOf({ rating: null }, 'a.md'), false);
  assert.deepEqual(rating({ explicit: false, allowUnrated: true }, { explicit: 'no' }), ['rating.explicit']);
  for (const contentRating of ['PG', {}, [null], [{ value: 'PG' }], [{ scheme: 5, value: 'PG' }]]) {
    assert.deepEqual(rating({ schemes: { 'example-scheme': ['PG'] }, allowUnrated: true }, { contentRating }), ['rating.example-scheme'], JSON.stringify(contentRating));
  }
  assert.deepEqual(rating({ schemes: { 'example-scheme': ['PG'] } }, { contentRating: [{ scheme: 'example-scheme', value: 5 }] }), ['rating.example-scheme']);
});

test('a rating request the Reader cannot honour removes every record', () => {
  const clean = { explicit: false };
  assert.deepEqual(rating({ explicit: false }, clean), []);
  assert.deepEqual(rating({ explicit: false, mode: 'strict-path' }, clean), ['rating.request']);
  assert.deepEqual(rating({ explicit: false, somethingNew: true }, clean), ['rating.request']);
  assert.deepEqual(rating({ schemes: ['PG'] }, clean), ['rating.request']);
  for (const request of ['strict', true, null, []]) assert.deepEqual(rating(request, clean), ['rating.request'], JSON.stringify(request));
  // A listed scheme whose allowed set is not a list allows nothing.
  assert.deepEqual(rating({ schemes: { 'example-scheme': 'PG' } }, { contentRating: [{ scheme: 'example-scheme', value: 'PG' }] }), ['rating.example-scheme']);
});

test('a search with a terms request removes a package whose ai.allowed is not an object', async () => {
  const result = await readPackage(makePackage({ id: ID, version: '1.0.0', title: 'T', terms: { ai: { allowed: false } } }));
  assert.deepEqual(codes(result), ['U001_TERMS_INVALID']);
  const library = new Library({ clock: () => new Date('2026-11-21T00:00:00Z') }).add(result);
  const search = new Search(library, { backend: new LexicalBackend(library) });
  assert.equal((await search.search('lantern', { limit: 5 })).length, 1);
  assert.equal((await search.search('lantern', { limit: 5, terms: { ai: { destination: 'device', use: 'answer' } } })).length, 0);
  assert.deepEqual(search.diagnostics.map((d) => d.code), ['U004_TERMS_EXCLUDED']);
});

// --- A manifest of the wrong shape never stops the read (contract §5) ---

test('a manifest that is not an object, or has members of the wrong type, is M002 and never throws', async () => {
  for (const manifest of ['null', '[]', '5', '"text"', 'true']) {
    const result = await readPackage(makePackage(manifest), { trustRoot: { keys: [] } });
    assert.equal(result.valid, false, manifest);
    assert.deepEqual([...new Set(codes(result))], ['M002_MANIFEST_SCHEMA'], manifest);
    assert.equal(result.manifest, null);
  }
  const base = { id: ID, version: '1.0.0', title: 'T' };
  for (const more of [{ locales: 5 }, { locales: [1] }, { locales: 'fr' }, { locales: null }, { locales: { fr: true } }, { members: 5 }, { relations: 'x' }, { profiles: 5 }, { terms: 5 }, { readingOrder: 5 }]) {
    const result = await readPackage(makePackage({ ...base, ...more }, { 'content/a.md': NODE, 'content/a.fr.md': NODE }), { trustRoot: { keys: [] } });
    assert.equal(result.valid, false, JSON.stringify(more));
    assert.ok(codes(result).includes('M002_MANIFEST_SCHEMA'), JSON.stringify(more));
  }
});

// --- Archive records (contract §3) ---

function archive() {
  const zip = new AdmZip();
  zip.addFile('moca.json', Buffer.from(JSON.stringify({ id: ID, version: '1.0.0', title: 'T' })));
  zip.addFile('content/a.md', Buffer.from(NODE));
  return zip.toBuffer();
}
// Archive bytes given to readPackage: a rejected archive is reported, never thrown.
const rejected = async (bytes) => codes(await readPackage(new Uint8Array(bytes)));

test('an archive has exactly one end record, and local headers that agree with the directory (T003)', async () => {
  const good = archive();
  assert.equal((await readPackage(new Uint8Array(good))).valid, true);
  assert.equal((await readPackage(archiveSource(good))).valid, true);

  // A second end record in the comment of the first.
  const end = good.length - 22;
  const first = Buffer.from(good.subarray(end));
  first.writeUInt16LE(22, 20);
  assert.deepEqual(await rejected(Buffer.concat([good.subarray(0, end), first, good.subarray(end)])), ['T003_ARCHIVE_REJECTED']);

  // Bytes after the end record: no record ends at the end of the file.
  assert.deepEqual(await rejected(Buffer.concat([good, Buffer.from('more')])), ['T003_ARCHIVE_REJECTED']);

  // A local header that names another file than the directory does.
  const renamed = Buffer.from(good);
  const name = Buffer.from('content/a.md');
  for (let i = 0; i < renamed.length - 4; i++) {
    if (renamed.readUInt32LE(i) === 0x04034b50 && renamed.subarray(i + 30, i + 30 + name.length).equals(name)) renamed.write('content/b.md', i + 30);
  }
  assert.deepEqual(await rejected(renamed), ['T003_ARCHIVE_REJECTED']);

  // A local header with another compression method.
  const method = Buffer.from(good);
  method.writeUInt16LE(method.readUInt16LE(8) === 0 ? 8 : 0, 8);
  assert.deepEqual(await rejected(method), ['T003_ARCHIVE_REJECTED']);

  // An entry count the directory does not hold; a multi-disk archive; Zip64 markers.
  for (const [offset, value, width] of [[10, 3, 2], [4, 1, 2], [10, 0xffff, 2], [16, 0xffffffff, 4]]) {
    const changed = Buffer.from(good);
    if (width === 2) changed.writeUInt16LE(value, end + offset);
    else changed.writeUInt32LE(value, end + offset);
    assert.deepEqual(await rejected(changed), ['T003_ARCHIVE_REJECTED'], `${offset}`);
  }
  assert.deepEqual(await rejected(Buffer.alloc(10)), ['T003_ARCHIVE_REJECTED']);
});

// --- Text work stays roughly linear (contract §3) ---

test('link targets are found as before, in one pass', () => {
  const cases = {
    'see [a](b.md) and ![img](../media/x.png "title")': ['b.md', '../media/x.png'],
    '[a](<b c.md>) [d]( e.md \'t\' ) [f](g.md"x")': ['<b c.md>', 'e.md', 'g.md"x"'],
    '[a](b.md "unclosed) [c](d.md)': ['d.md'],
    '[[nested](x.md)](y.md)': ['x.md'],
    '[a] (b.md) [c]() [d](<>) [e](<f>g)': ['<>', '<f>g'],
    '[no link] and (b.md) and ](c.md)': [],
    '![a](b.md)[c](d.md)': ['b.md', 'd.md'],
    '': [],
  };
  for (const [line, expected] of Object.entries(cases)) assert.deepEqual(linkTargets(line), expected, line);
});

test('unclosed brackets and tags cost no more than any other text of their length', () => {
  const inputs = [
    () => linkTargets('['.repeat(400_000)),
    () => linkTargets('[](a '.repeat(80_000)),
    () => linkTargets(`${'[](<x '.repeat(60_000)}>${' '.repeat(100_000)}z`),
    () => linkTargets(`${'[](a "'.repeat(60_000)}"${' '.repeat(100_000)}z`),
    () => markdownText('['.repeat(400_000)),
    () => markdownText('[]('.repeat(150_000)),
    () => htmlText('<script>'.repeat(100_000)),
    () => htmlText('<style>'.repeat(60_000) + '<script>'.repeat(60_000)),
    () => htmlText('<'.repeat(800_000)),
  ];
  for (const [i, run] of inputs.entries()) {
    const started = performance.now();
    run();
    assert.ok(performance.now() - started < 2000, `input ${i} took too long`);
  }
});

test('Markdown and HTML sources are normalised as before', () => {
  assert.equal(markdownText('# Title\n\n- a [link](x.md) and ![alt](y.png)\n2. *two* `code` [not a link] (z)\n[open](never closed'), 'Title\n\na link and alt\ntwo code [not a link] (z)\n[open](never closed');
  assert.equal(markdownText('![a[b](c)](d)'), 'a[b](d)');
  assert.equal(htmlText('<p>One &amp; <b>two</b></p><script>var a = "</p>";</script><STYLE type="x">p{}</style >three<script>never closed'), 'One & twothreenever closed');
  assert.equal(htmlText('a < b and c > d <br/> e <unclosed'), 'a  d  e <unclosed');
  assert.equal(htmlText('<scripts>kept</scripts> <script >gone</SCRIPT>'), 'kept ');
});

// --- Nesting (contract §3): 64 levels are read, 65 are malformed ---

test('JSON nested more than 64 levels deep is refused before it is parsed', async () => {
  const { nestedTooDeep, parseJson, MAX_NESTING } = await import('../lib/json-strict.js');
  assert.equal(MAX_NESTING, 64);
  const arrays = (n) => `${'['.repeat(n)}${']'.repeat(n)}`;
  const objects = (n) => `${'{"a":'.repeat(n)}1${'}'.repeat(n)}`;
  for (const make of [arrays, objects]) {
    assert.equal(nestedTooDeep(make(64)), false);
    assert.equal(nestedTooDeep(make(65)), true);
    assert.doesNotThrow(() => parseJson(make(64)));
    assert.throws(() => parseJson(make(65)), /64 levels/);
  }
  // Brackets inside strings are text; siblings do not add levels.
  assert.equal(nestedTooDeep(JSON.stringify({ a: '['.repeat(500), 'b\\"[': '{'.repeat(500) })), false);
  assert.equal(nestedTooDeep(`[${Array.from({ length: 1000 }, () => '[]').join(',')}]`), false);
  // Far past the limit costs one pass, and never reaches the parser.
  const started = performance.now();
  assert.throws(() => parseJson('['.repeat(5_000_000)), /64 levels/);
  assert.ok(performance.now() - started < 2000);
});

test('each kind of package JSON reports nesting past the limit with its own code', async () => {
  const deep = `${'['.repeat(64)}${']'.repeat(64)}`;
  const base = { id: ID, version: '1.0.0', title: 'T' };
  const manifest = (depth) => `{"id":"${ID}","version":"1.0.0","title":"T","x-example-nested":${'['.repeat(depth)}${']'.repeat(depth)}}`;
  assert.deepEqual(codes(await readPackage(makePackage(manifest(63)))), []);
  assert.deepEqual(codes(await readPackage(makePackage(manifest(64)))), ['M001_MANIFEST_INVALID_JSON']);
  assert.deepEqual(codes(await readPackage(makePackage('['.repeat(200_000)))), ['M001_MANIFEST_INVALID_JSON']);

  // An attestation file, and the statement inside one.
  const keys = keyPair();
  const signed = await signedPackage(keys);
  assert.deepEqual(codes(await readPackage(signed, { trustRoot: trustRootFor(keys) })), []);
  const file = join(signed, 'attestations', 'package.k.dsse.json');
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(envelope).replace(/\}$/, `,"x":${deep}}`));
  assert.deepEqual(codes(await readPackage(signed, { trustRoot: trustRootFor(keys) })), ['A001_ATTESTATION_MALFORMED']);
  const statement = `{"_type":"https://in-toto.io/Statement/v1","subject":[],"predicateType":"https://w3id.org/moca/attestation/package/v1","predicate":${deep}}`;
  writeFileSync(file, JSON.stringify({ ...envelope, payload: Buffer.from(statement).toString('base64') }));
  assert.deepEqual(codes(await readPackage(signed, { trustRoot: trustRootFor(keys) })), ['A001_ATTESTATION_MALFORMED']);

  // A sidecar's index.json.
  const pkg = await readPackage(makePackage(base));
  const sidecar = mkdtempSync(join(tmpdir(), 'moca-sidecar-'));
  writeFileSync(join(sidecar, 'index.json'), `{"x":${deep}}`);
  const bound = bindSidecar(sidecar, pkg);
  assert.equal(bound.usable, false);
  assert.match(bound.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'), /S001_SIDECAR_INVALID index\.json is not valid JSON: nested more than 64 levels deep/);
});

test('frontmatter nested more than 64 levels deep is invalid (C002)', async () => {
  const node = (depth) => `---\ntype: Note\ntitle: A\nx: ${'['.repeat(depth)}${']'.repeat(depth)}\n---\n\n# A\n`;
  const base = { id: ID, version: '1.0.0', title: 'T' };
  // The frontmatter mapping is the first level.
  assert.deepEqual(codes(await readPackage(makePackage(base, { 'content/a.md': node(63) }))), []);
  assert.ok(codes(await readPackage(makePackage(base, { 'content/a.md': node(64) }))).includes('C002_FRONTMATTER_INVALID'));
  assert.ok(codes(await readPackage(makePackage(base, { 'content/a.md': node(20_000) }))).includes('C002_FRONTMATTER_INVALID'));
  // Block style counts the same way: mappings inside mappings.
  const block = (depth) => `---\ntype: Note\ntitle: A\n${Array.from({ length: depth }, (_, i) => `${' '.repeat(i)}k:`).join('\n')} 1\n---\n\n# A\n`;
  assert.deepEqual(codes(await readPackage(makePackage(base, { 'content/a.md': block(63) }))), []);
  assert.ok(codes(await readPackage(makePackage(base, { 'content/a.md': block(64) }))).includes('C002_FRONTMATTER_INVALID'));
});
