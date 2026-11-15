// Encrypted packages (moca-spec spec/moca-encrypted-package.md): what the corpus cannot show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { readPackage, bindEnvelopeSidecar, openSource } from '../lib/index.js';
import { ageDecryptor } from '../lib/age.js';

const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../moca-spec/', import.meta.url));
const envelopes = join(spec, 'conformance/fixtures/envelopes');
const identityFile = join(envelopes, 'keys/INSECURE-test.txt');
const otherFile = join(envelopes, 'keys/INSECURE-other.txt');
const identitiesIn = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('AGE-SECRET-KEY-1'));
const withKey = (file) => ({ decryptor: ageDecryptor, keyProvider: () => ({ identities: identitiesIn(file) }) });
const skip = existsSync(envelopes) ? false : 'moca-spec has no envelope fixtures';

test('without a decryptor, an envelope is recognised and not opened (E001)', { skip }, async () => {
  const r = await readPackage(join(envelopes, 'x25519.mocae'), { keyProvider: () => ({ identities: identitiesIn(identityFile) }) });
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
  const r = await readPackage(join(envelopes, 'extra-entry.mocae'));
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['E005_ENVELOPE_INVALID']);
});

test('an envelope given as bytes opens like one given as a path', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(join(envelopes, 'x25519.mocae')));
  const [a, b] = await Promise.all([readPackage(bytes, withKey(identityFile)), readPackage(join(envelopes, 'x25519.mocae'), withKey(identityFile))]);
  assert.equal(a.valid, true);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a.envelope, { format: 'moca-enc-v1', opened: true });
});

test('a key provider that throws is E001, never thrown to the caller', { skip }, async () => {
  const r = await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: ageDecryptor, keyProvider: () => { throw new Error('vault offline'); } });
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['E001_ENCRYPTED_NO_KEY']);
});

test('the key provider gets the stanzas, the unverified outline and the file', { skip }, async () => {
  let seen;
  await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: ageDecryptor, keyProvider: (req) => { seen = req; return null; } });
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
    const r = await readPackage(join(envelopes, 'large.mocae'), withKey(identityFile));
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
  const envelope = new AdmZip(join(envelopes, 'x25519.mocae'));
  envelope.addFile('index.age', indexAge);
  envelope.getEntry('index.age').header.method = 0;
  const dir = mkdtempSync(join(tmpdir(), 'moca-index-age-'));
  const path = join(dir, 'with-index.mocae');
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

test('a key provider error never reaches a diagnostic: only its type name does', { skip }, async () => {
  const r = await readPackage(join(envelopes, 'x25519.mocae'), {
    decryptor: ageDecryptor,
    keyProvider: () => { throw new TypeError('vault https://vault.example/v1?token=s3cret is offline'); },
  });
  const [d] = r.diagnostics;
  assert.equal(d.code, 'E001_ENCRYPTED_NO_KEY');
  assert.ok(!/s3cret|vault\.example/.test(d.message), d.message);
  assert.match(d.message, /TypeError/);
});

test('nothing a decryptor throws reaches the caller: E006 while parsing, E002 after', { skip }, async () => {
  const boom = () => { throw new RangeError('internal'); };
  const parse = await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: { parseHeader: boom, decrypt: boom }, keyProvider: () => ({ identities: [] }) });
  assert.deepEqual(parse.diagnostics.map((d) => d.code), ['E006_AGE_HEADER_INVALID']);
  const later = await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: { parseHeader: ageDecryptor.parseHeader, decrypt: boom }, keyProvider: () => ({ identities: [] }) });
  assert.deepEqual(later.diagnostics.map((d) => d.code), ['E002_DECRYPTION_FAILED']);
  // Odd provider results: not an object is E001; members of the wrong type are E002.
  for (const [result, code] of [[42, 'E001_ENCRYPTED_NO_KEY'], [[], 'E001_ENCRYPTED_NO_KEY'], [{ identities: [7] }, 'E002_DECRYPTION_FAILED'], [{ fileKey: [1, 2] }, 'E002_DECRYPTION_FAILED']]) {
    const r = await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: ageDecryptor, keyProvider: () => result });
    assert.deepEqual(r.diagnostics.map((d) => d.code), [code], JSON.stringify(result));
  }
});

test('a work-factor limit outside 1–22 is a host error', { skip }, async () => {
  for (const bad of [Number.NaN, 40, 0]) {
    await assert.rejects(readPackage(join(envelopes, 'passphrase.mocae'), { ...withKey(identityFile), limits: { maxScryptWorkFactor: bad } }), RangeError);
  }
});

test('an undefined work-factor limit is the default, and the limit is checked when the read starts', { skip }, async () => {
  const r = await readPackage(join(envelopes, 'x25519.mocae'), { ...withKey(identityFile), limits: { maxScryptWorkFactor: undefined } });
  assert.equal(r.valid, true);
  // An invalid limit is refused even when no envelope is read.
  await assert.rejects(readPackage(join(spec, 'examples/support-kb'), { limits: { maxScryptWorkFactor: 40 } }), RangeError);
  await assert.rejects(bindEnvelopeSidecar(join(envelopes, 'x25519.mocae'), null, { limits: { maxScryptWorkFactor: 0 } }), RangeError);
});

test('null identities are E002, as in every Reader', { skip }, async () => {
  const r = await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: ageDecryptor, keyProvider: () => ({ identities: null }) });
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['E002_DECRYPTION_FAILED']);
});

test('an AbortError from a provider or decryptor is a failure, not the host cancelling', { skip }, async () => {
  const abort = () => { throw new DOMException('timed out', 'AbortError'); };
  const provider = await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: ageDecryptor, keyProvider: abort });
  assert.deepEqual(provider.diagnostics.map((d) => d.code), ['E001_ENCRYPTED_NO_KEY']);
  const parse = await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: { parseHeader: abort, decrypt: abort }, keyProvider: () => ({ identities: [] }) });
  assert.deepEqual(parse.diagnostics.map((d) => d.code), ['E006_AGE_HEADER_INVALID']);
  const later = await readPackage(join(envelopes, 'x25519.mocae'), { decryptor: { parseHeader: ageDecryptor.parseHeader, decrypt: abort }, keyProvider: () => ({ identities: [] }) });
  assert.deepEqual(later.diagnostics.map((d) => d.code), ['E002_DECRYPTION_FAILED']);
});

test('the ciphertext and the plaintext are passed on in place, never copied (F4)', { skip }, async () => {
  const seen = [];
  const decryptor = {
    parseHeader: (bytes, o) => { seen.push(['header', bytes]); return ageDecryptor.parseHeader(bytes, o); },
    decrypt: async (bytes, header, key, o) => {
      seen.push(['decrypt', bytes]);
      const plain = await ageDecryptor.decrypt(bytes, header, key, o);
      seen.push(['plain', plain]);
      return plain;
    },
  };
  const archive = readFileSync(join(envelopes, 'x25519.mocae'));
  const r = await readPackage(archive, { decryptor, keyProvider: () => ({ identities: identitiesIn(identityFile) }) });
  assert.equal(r.valid, true);
  const [[, parsed], [, decrypted], [, plain]] = seen;
  // The decryptor gets the same bytes it parsed, and they are a view into the envelope itself.
  assert.equal(parsed, decrypted);
  assert.equal(parsed.buffer, archive.buffer);
  assert.ok(plain instanceof Uint8Array && plain.length > 0);
  // Bytes given as a target are read in place: zero them, and the source sees zeros.
  const zip = new AdmZip();
  zip.addFile('a.txt', Buffer.from('hello'));
  zip.getEntry('a.txt').header.method = 0;
  const bytes = new Uint8Array(zip.toBuffer());
  const source = openSource(bytes);
  bytes.fill(0);
  assert.throws(() => source.read('a.txt'));
});
