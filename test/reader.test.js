import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { readPackage, hostSource, archiveSource, Library, validateAgainst } from '../lib/index.js';

function makePackage(files, manifest = { id: 'https://example.com/t', version: '1.0.0', title: 'T' }) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-core-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify(manifest));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const NODE = '---\ntype: Note\ntitle: A\n---\n\n# A\n\nText about refunds.\n';
const codes = (r) => r.diagnostics.map((d) => d.code);

test('the digest is the same for a directory, an archive and a host source', async () => {
  const dir = makePackage({ 'content/a.md': NODE });
  const fromDir = await readPackage(dir);
  const zip = new AdmZip();
  zip.addFile('moca.json', readFileSync(join(dir, 'moca.json')));
  zip.addFile('content/a.md', readFileSync(join(dir, 'content/a.md')));
  const fromZip = await readPackage(hostSource({ list: () => ['moca.json', 'content/a.md'], read: (p) => readFileSync(join(dir, p)) }));
  const archive = join(dir, '..', `${Date.now()}.moca`);
  zip.writeZip(archive);
  const fromArchive = await readPackage(archive);
  assert.match(fromDir.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fromZip.digest, fromDir.digest);
  assert.equal(fromArchive.digest, fromDir.digest);
  rmSync(archive);
});

test('the digest is the SHA-256 of a BagIt-style manifest that includes moca.json as bytes', async () => {
  const a = makePackage({ 'content/a.md': NODE, 'sources/100%.txt': 'x' });
  const b = makePackage({ 'content/a.md': NODE, 'sources/100%.txt': 'x' });
  writeFileSync(join(b, 'moca.json'), '{\n  "title": "T",\n  "version": "1.0.0",\n  "id": "https://example.com/t"\n}\n');
  const [ra, rb] = await Promise.all([readPackage(a), readPackage(b)]);
  assert.notEqual(ra.digest, rb.digest, 'moca.json is hashed as bytes, so reformatting changes the digest');
  const lines = ra.payloadManifest.trimEnd().split('\n');
  assert.deepEqual(lines.map((l) => l.split('  ')[1]), ['content/a.md', 'moca.json', 'sources/100%25.txt']);
  assert.ok(lines.every((l) => /^[a-f0-9]{64}  \S/.test(l)));
  assert.equal(ra.digest, `sha256:${createHash('sha256').update(ra.payloadManifest, 'utf8').digest('hex')}`);
});

test('attestations/ and hidden entries are outside the digest', async () => {
  const a = makePackage({ 'content/a.md': NODE });
  const b = makePackage({ 'content/a.md': NODE, 'attestations/x.dsse.json': '{}', '.git/HEAD': 'ref', 'content/.DS_Store': 'x' });
  assert.equal((await readPackage(a)).digest, (await readPackage(b)).digest);
});

test('a symbolic link fails the package closed (P001) instead of being skipped', { skip: process.platform === 'win32' }, async () => {
  const outside = mkdtempSync(join(tmpdir(), 'moca-outside-'));
  writeFileSync(join(outside, 'b.md'), NODE);
  const dir = makePackage({ 'content/a.md': NODE });
  symlinkSync(join(outside, 'b.md'), join(dir, 'content', 'b.md'));
  const r = await readPackage(dir);
  assert.ok(codes(r).includes('P001_UNSUPPORTED_ENTRY'));
  assert.equal(r.digest, null);
  assert.equal(r.valid, false);
});

test('an unreadable folder fails the package closed (P002)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const dir = makePackage({ 'content/a.md': NODE, 'content/locked/b.md': NODE });
  chmodSync(join(dir, 'content', 'locked'), 0o000);
  try {
    const r = await readPackage(dir);
    assert.ok(codes(r).includes('P002_UNREADABLE_ENTRY'));
    assert.equal(r.digest, null);
    assert.equal(r.valid, false);
  } finally {
    chmodSync(join(dir, 'content', 'locked'), 0o755);
  }
});

test('paths that collide after NFC normalisation or case folding are refused (P003)', async () => {
  const files = ['moca.json', 'content/café.md', 'content/café.md'];
  const bytes = { 'moca.json': JSON.stringify({ id: 'https://example.com/t', version: '1.0.0', title: 'T' }) };
  const r = await readPackage(hostSource({ list: () => files, read: (p) => Buffer.from(bytes[p] ?? NODE) }));
  assert.ok(codes(r).includes('P003_PATH_COLLISION'));
  const r2 = await readPackage(hostSource({ list: () => ['moca.json', 'content/A.md', 'content/a.md'], read: (p) => Buffer.from(bytes[p] ?? NODE) }));
  assert.ok(codes(r2).includes('P003_PATH_COLLISION'));
  // Lower-casing is the simple mapping per code point (package spec §6.3): İ is i, not i + U+0307.
  const r3 = await readPackage(hostSource({ list: () => ['moca.json', 'content/\u0130.md', 'content/i.md'], read: (p) => Buffer.from(bytes[p] ?? NODE) }));
  assert.ok(codes(r3).includes('P003_PATH_COLLISION'));
  const r4 = await readPackage(hostSource({ list: () => ['moca.json', 'content/\u0130.md', 'content/i\u0307.md'], read: (p) => Buffer.from(bytes[p] ?? NODE) }));
  assert.ok(!codes(r4).includes('P003_PATH_COLLISION'));
});

test('archives with traversal entries are rejected before anything is read (T003)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moca-zip-'));
  const zip = new AdmZip();
  zip.addFile('moca.json', Buffer.from('{}'));
  zip.getEntries()[0].entryName = '../moca.json';
  const archive = join(dir, 'evil.moca');
  zip.writeZip(archive);
  const r = await readPackage(archive);
  assert.deepEqual(codes(r), ['T003_ARCHIVE_REJECTED']);
});

test('a host source cannot be asked for a path it did not list', async () => {
  const src = hostSource({ list: () => ['moca.json'], read: () => Buffer.from('{}') });
  src.list();
  assert.throws(() => src.read('secret.txt'));
});

test('missing target and missing manifest are distinct diagnostics', async () => {
  assert.deepEqual(codes(await readPackage('/no/such/place')), ['T001_TARGET_NOT_FOUND']);
  const empty = mkdtempSync(join(tmpdir(), 'moca-empty-'));
  assert.deepEqual(codes(await readPackage(empty)), ['T002_MANIFEST_NOT_FOUND']);
});

test('frontmatter timestamps stay strings, exactly as written', async () => {
  const dir = makePackage({ 'content/a.md': '---\ntype: Note\nstale_after: 2026-08-14\n---\n# A\n' });
  const r = await readPackage(dir);
  assert.equal(r.nodes[0].representations[0].frontmatter.stale_after, '2026-08-14');
});

test('citation records carry freshness, supersession and contest, and validate against the schema', async () => {
  const oldPkg = makePackage({ 'content/p.md': NODE }, { id: 'https://example.com/policy', version: '1.0.0', title: 'P', validUntil: '2026-04-01T00:00:00Z' });
  const newPkg = makePackage(
    { 'content/p.md': '---\ntype: Note\nstale_after: 2026-05-01T00:00:00Z\nmoca:\n  contested_by: ["https://example.com/other#x.md"]\n---\n# P\n\nrefunds\n' },
    { id: 'https://example.com/policy', version: '2.0.0', title: 'P', relations: [{ type: 'supersedes', target: 'https://example.com/policy', version: '1.0.0' }] },
  );
  // Unsigned test packages: the host allows unsigned relations (package spec §7.2).
  const lib = new Library({ clock: () => new Date('2026-06-01T00:00:00Z'), allowUnsignedRelations: true });
  lib.add(await readPackage(oldPkg)).add(await readPackage(newPkg));
  const [oldRec, newRec] = lib.citations();
  assert.equal(oldRec.trust.superseded, true);
  assert.deepEqual(oldRec.trust.supersededBy, ['https://example.com/policy@2.0.0']);
  assert.equal(oldRec.trust.inForce, false);
  assert.equal(newRec.trust.stale, true);
  assert.equal(newRec.trust.contested, true);
  for (const rec of [oldRec, newRec]) assert.deepEqual(validateAgainst('citationRecord', rec), []);
});

test('the default retrieval policy leaves out superseded, out-of-force and deprecated content', async () => {
  const a = makePackage({ 'content/p.md': NODE, 'content/d.md': '---\ntype: Note\nstatus: deprecated\n---\nrefunds\n' },
    { id: 'https://example.com/a', version: '1.0.0', title: 'A' });
  const lib = new Library().add(await readPackage(a));
  assert.deepEqual(lib.search('refunds').map((r) => r.node.path), ['p.md']);
  assert.deepEqual(lib.search('refunds', { includeAll: true }).map((r) => r.node.path).sort(), ['d.md', 'p.md']);
});

test('audience filtering is applied before results are returned', async () => {
  const a = makePackage({
    'content/pub.md': '---\ntype: Note\nmoca:\n  audience: public\n---\nrefunds\n',
    'content/int.md': '---\ntype: Note\nmoca:\n  audience: internal\n---\nrefunds\n',
  });
  const lib = new Library().add(await readPackage(a));
  assert.deepEqual(lib.search('refunds', { audiences: ['public'] }).map((r) => r.node.path), ['pub.md']);
});

test('an invalid package cannot be added to a library', async () => {
  const dir = makePackage({ 'content/a.md': '# no frontmatter\n' });
  assert.throws(() => new Library().add(readPackage(dir)));
  const r = await readPackage(dir);
  assert.throws(() => new Library().add(r));
});

test('a link destination in angle brackets is read as written: URLs are not package paths', async () => {
  const body = '---\ntype: Note\ntitle: A\n---\n\n# A\n\nSee [the PDF](<https://example.com/a (1).pdf#page=2>), [B](<b.md>) and [C](<missing.md>).\n';
  const dir = makePackage({ 'content/a.md': body, 'content/b.md': NODE });
  try {
    const result = await readPackage(dir);
    assert.deepEqual(result.diagnostics.filter((d) => d.code === 'C007_LINK_UNRESOLVED').map((d) => d.message), ['link "missing.md" does not resolve']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an archive whose sizes lie is P002, inflated no further than it declared', async () => {
  const zip = new AdmZip();
  zip.addFile('moca.json', Buffer.from(JSON.stringify({ mocaVersion: '0.4', id: 'https://example.com/moca/liar', version: '1.0.0', title: 'Liar' })));
  zip.addFile('content/big.md', Buffer.alloc(8 * 1024 * 1024, 0x61));
  const bytes = zip.toBuffer();
  // Say content/big.md holds 100 bytes, in its local and central headers.
  const name = Buffer.from('content/big.md');
  for (let i = 0; i < bytes.length - 4; i++) {
    const sig = bytes.readUInt32LE(i);
    if (sig === 0x04034b50 && bytes.subarray(i + 30, i + 30 + name.length).equals(name)) bytes.writeUInt32LE(100, i + 22);
    if (sig === 0x02014b50 && bytes.subarray(i + 46, i + 46 + name.length).equals(name)) bytes.writeUInt32LE(100, i + 24);
  }
  const result = await readPackage(archiveSource(bytes));
  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code), ['P002_UNREADABLE_ENTRY']);
});

test('an archive entry that fails its CRC-32 is P002', async () => {
  const zip = new AdmZip();
  zip.addFile('moca.json', Buffer.from(JSON.stringify({ mocaVersion: '0.4', id: 'https://example.com/moca/crc', version: '1.0.0', title: 'CRC' })));
  zip.addFile('content/a.md', Buffer.alloc(50 * 1024, 0x62));
  const bytes = zip.toBuffer();
  const name = Buffer.from('content/a.md');
  // Change the CRC-32 in the local and central headers.
  for (let i = 0; i < bytes.length - 4; i++) {
    const sig = bytes.readUInt32LE(i);
    if (sig === 0x04034b50 && bytes.subarray(i + 30, i + 30 + name.length).equals(name)) bytes.writeUInt32LE(0xdeadbeef, i + 14);
    if (sig === 0x02014b50 && bytes.subarray(i + 46, i + 46 + name.length).equals(name)) bytes.writeUInt32LE(0xdeadbeef, i + 16);
  }
  const result = await readPackage(archiveSource(bytes));
  const p002 = result.diagnostics.find((d) => d.code === 'P002_UNREADABLE_ENTRY');
  assert.match(p002.message, /CRC-32/);
});

test('composition is bounded: members past maxMemberDepth or maxMembers are not resolved (R001)', async () => {
  const leaf = (n) => makePackage({ 'content/a.md': NODE }, { id: `https://example.com/leaf${n}`, version: '1.0.0', title: 'L' });
  const leaves = [leaf(1), leaf(2)];
  const pins = await Promise.all(leaves.map(async (dir, i) => ({ id: `https://example.com/leaf${i + 1}`, version: '1.0.0', digest: (await readPackage(dir)).digest })));
  const composite = makePackage({}, { id: 'https://example.com/c', version: '1.0.0', title: 'C', members: pins });
  const resolveMember = (m) => leaves[Number(m.id.slice(-1)) - 1];

  const ok = await readPackage(composite, { resolveMember });
  assert.deepEqual(ok.members.map((m) => m.status), ['resolved', 'resolved']);

  const shallow = await readPackage(composite, { resolveMember, limits: { maxMemberDepth: 0 } });
  assert.deepEqual(codes(shallow), ['R001_MEMBER_UNRESOLVED', 'R001_MEMBER_UNRESOLVED']);
  assert.match(shallow.diagnostics[0].message, /deeper than 0 levels/);

  const few = await readPackage(composite, { resolveMember, limits: { maxMembers: 1 } });
  assert.deepEqual(few.members.map((m) => m.status), ['resolved', 'unresolved']);
  assert.match(few.diagnostics.find((d) => d.code === 'R001_MEMBER_UNRESOLVED').message, /more than 1 members/);
});

test('sigstore.trustedRoot: unusable trust material is A003; a malformed bundle against it is A002 (attestations §6, §7)', async () => {
  const id = 'https://example.com/t';
  const dir = makePackage({ 'content/a.md': NODE });
  const { digest } = await readPackage(dir);
  const statement = { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: `${id}@1.0.0`, digest: { sha256: digest.slice(7) } }], predicateType: 'https://w3id.org/moca/attestation/package/v1', predicate: {} };
  const bundle = { dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'), signatures: [{ keyid: '', sig: 'AAAA' }] } };
  mkdirSync(join(dir, 'attestations'));
  writeFileSync(join(dir, 'attestations', 'package.sigstore.json'), JSON.stringify(bundle));
  const identities = [{ issuer: 'https://issuer.example', subject: 'ci@example.com', roles: ['package'] }];

  const unusable = await readPackage(dir, { trustRoot: { keys: [], sigstore: { identities, trustedRoot: { certificateAuthorities: [{ subject: 1 }] } } } });
  const malformed = await readPackage(dir, { trustRoot: { keys: [], sigstore: { identities, trustedRoot: {} } } });

  assert.deepEqual(codes(unusable), ['A003_ATTESTATION_UNVERIFIABLE']);
  assert.match(unusable.diagnostics[0].message, /trustedRoot cannot be used/);
  assert.deepEqual(codes(malformed), ['A002_ATTESTATION_INVALID']);
  assert.match(malformed.diagnostics[0].message, /not a valid Sigstore bundle/);
});
