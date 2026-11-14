// Encrypted packages (moca-spec spec/moca-encrypted-package.md): what the corpus cannot show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { readPackage, bindEnvelopeSidecar } from '../lib/index.js';
import { ageDecryptor } from '../lib/age.js';

const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../moca-spec/', import.meta.url));
const envelopes = join(spec, 'conformance/fixtures/envelopes');
const identityFile = join(envelopes, 'keys/INSECURE-test.txt');
const otherFile = join(envelopes, 'keys/INSECURE-other.txt');
const identitiesIn = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('AGE-SECRET-KEY-1'));
const withKey = (file) => ({ decryptor: ageDecryptor, keyProvider: () => ({ identities: identitiesIn(file) }) });
const skip = existsSync(envelopes) ? false : 'moca-spec has no envelope fixtures';

test('without a decryptor, an envelope is recognised and not opened (E001)', { skip }, async () => {
  const r = await readPackage(join(envelopes, 'x25519.moca.enc'), { keyProvider: () => ({ identities: identitiesIn(identityFile) }) });
  assert.equal(r.valid, false);
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['E001_ENCRYPTED_NO_KEY']);
  assert.equal(r.envelope.opened, false);
  assert.equal(r.envelope.format, 'moca-enc-v1');
  assert.deepEqual(r.envelope.outline, { id: 'https://example.com/conformance/minimal', version: '1.0.0', title: 'Fixture' });
  assert.equal(r.manifest, null);
  assert.equal(r.digest, null);
  assert.deepEqual(r.nodes, []);
});

test('without a decryptor, the entry checks still run (E005 before E001)', { skip }, async () => {
  const r = await readPackage(join(envelopes, 'extra-entry.moca.enc'));
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['E005_ENVELOPE_INVALID']);
});

test('an envelope given as bytes opens like one given as a path', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(join(envelopes, 'x25519.moca.enc')));
  const [a, b] = await Promise.all([readPackage(bytes, withKey(identityFile)), readPackage(join(envelopes, 'x25519.moca.enc'), withKey(identityFile))]);
  assert.equal(a.valid, true);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a.envelope, { format: 'moca-enc-v1', opened: true });
});

test('a key provider that throws is E001, never thrown to the caller', { skip }, async () => {
  const r = await readPackage(join(envelopes, 'x25519.moca.enc'), { decryptor: ageDecryptor, keyProvider: () => { throw new Error('vault offline'); } });
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['E001_ENCRYPTED_NO_KEY']);
});

test('the key provider gets the stanzas, the unverified outline and the file', { skip }, async () => {
  let seen;
  await readPackage(join(envelopes, 'x25519.moca.enc'), { decryptor: ageDecryptor, keyProvider: (req) => { seen = req; return null; } });
  assert.equal(seen.file, 'package');
  assert.equal(seen.stanzas[0].type, 'X25519');
  assert.equal(seen.stanzas[0].body.length, 32);
  assert.equal(seen.outline.title, 'Fixture');
});

// Encrypted packages §5.4: decrypted bytes never go to a file. Reading with a temporary directory that cannot be
// written to shows the Reader does not need one.
test('an envelope opens with a temporary directory that cannot be written to', { skip: skip || (process.platform === 'win32' ? 'POSIX permissions only' : process.getuid?.() === 0 ? 'root can write anywhere' : false) }, async () => {
  const locked = mkdtempSync(join(tmpdir(), 'moca-locked-'));
  chmodSync(locked, 0o500);
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  Object.assign(process.env, { TMPDIR: locked, TMP: locked, TEMP: locked });
  try {
    assert.equal(tmpdir(), locked);
    const r = await readPackage(join(envelopes, 'large.moca.enc'), withKey(identityFile));
    assert.equal(r.valid, true);
    assert.equal(r.envelope.opened, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    chmodSync(locked, 0o700);
    rmSync(locked, { recursive: true });
  }
});

// Encrypted packages §6: index.age, encrypted at test time with the Go age CLI to the test key.
const goAge = spawnSync('age', ['--version']).status === 0;
test('index.age binds through the same key provider; a failure leaves the package valid', { skip: skip || (goAge ? false : 'the Go age CLI is not installed') }, async () => {
  const sidecar = new AdmZip();
  sidecar.addLocalFolder(join(spec, 'conformance/fixtures/sidecars/valid'));
  const recipient = readFileSync(identityFile, 'utf8').match(/public key: (age1\w+)/)[1];
  const indexAge = spawnSync('age', ['-r', recipient], { input: sidecar.toBuffer() }).stdout;
  const envelope = new AdmZip(join(envelopes, 'x25519.moca.enc'));
  envelope.addFile('index.age', indexAge);
  envelope.getEntry('index.age').header.method = 0;
  const dir = mkdtempSync(join(tmpdir(), 'moca-index-age-'));
  const path = join(dir, 'with-index.moca.enc');
  envelope.writeZip(path);
  try {
    const pkg = await readPackage(path, withKey(identityFile));
    assert.equal(pkg.valid, true);
    const bound = await bindEnvelopeSidecar(path, pkg, withKey(identityFile));
    assert.equal(bound.usable, true);
    assert.deepEqual(bound.diagnostics, []);
    const wrong = await bindEnvelopeSidecar(path, pkg, withKey(otherFile));
    assert.equal(wrong.usable, false);
    assert.deepEqual(wrong.diagnostics.map((d) => d.code), ['E002_DECRYPTION_FAILED']);
    assert.equal(pkg.valid, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
