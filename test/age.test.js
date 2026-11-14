// The C2SP age test kit (CCTV) against lib/age.js, and the moca-spec envelope fixtures against the Go age CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { ageDecryptor, createAgeDecryptor, AgeError, decodeIdentity, plaintextLength, MAX_STANZAS } from '../lib/age.js';

const kit = fileURLToPath(new URL('./fixtures/cctv-age/', import.meta.url));
const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../moca-spec/', import.meta.url));

/** Why a vector is not run. Each reason is recorded in the 0.7.0 notes. */
function skipReason(v) {
  if (v.armored) return 'ASCII armor: envelopes carry binary age only (encrypted packages §4)';
  return null;
}

/** A hybrid (ML-KEM) vector: Readers do not unwrap its stanzas, so it is run parse-only. */
const isHybrid = (v) => v.identities.some((i) => i.startsWith('AGE-SECRET-KEY-PQ-1'));

function parseVector(name) {
  const raw = readFileSync(join(kit, name));
  const split = raw.indexOf('\n\n');
  const meta = { identities: [], passphrases: [] };
  for (const line of raw.subarray(0, split).toString('utf8').split('\n')) {
    const at = line.indexOf(': ');
    const [k, v] = [line.slice(0, at), line.slice(at + 2)];
    if (k === 'expect') meta.expect = v;
    else if (k === 'payload') meta.payload = v;
    else if (k === 'identity') meta.identities.push(v);
    else if (k === 'passphrase') meta.passphrases.push(v);
    else if (k === 'armored') meta.armored = v === 'yes';
    else if (k === 'compressed') meta.compressed = v;
  }
  let body = raw.subarray(split + 2);
  if (meta.compressed === 'zlib') body = inflateSync(body);
  return { ...meta, body: new Uint8Array(body) };
}

/** What lib/age.js concludes, in CCTV's terms. */
async function outcome(v) {
  let header;
  try {
    // The kit uses the age reference limit for the work factor (22); MOCA's default is 20.
    header = ageDecryptor.parseHeader(v.body, { maxScryptWorkFactor: 22 });
  } catch (err) {
    if (err instanceof AgeError && err.kind === 'header') return { expect: 'header failure' };
    throw err;
  }
  const keys = v.identities.length > 0 ? [{ identities: v.identities }] : v.passphrases.map((passphrase) => ({ passphrase }));
  let last;
  for (const key of keys.length > 0 ? keys : [null]) {
    try {
      const plain = await ageDecryptor.decrypt(v.body, header, key);
      return { expect: 'success', payload: createHash('sha256').update(plain).digest('hex') };
    } catch (err) {
      if (!(err instanceof AgeError)) throw err;
      last = err;
      if (err.kind !== 'noMatch' && err.kind !== 'noKey') break;
    }
  }
  return {
    expect: { header: 'header failure', noKey: 'no match', noMatch: 'no match', mac: 'HMAC failure', payload: 'payload failure' }[last.kind],
  };
}

const vectors = readdirSync(kit).filter((n) => n !== 'README.md').sort();

test('the C2SP age test kit has every vector', () => {
  assert.equal(vectors.length, 147);
});

for (const name of vectors) {
  const v = parseVector(name);
  const reason = skipReason(v);
  if (!reason && isHybrid(v)) {
    // The parser sees every hybrid vector. A header the kit calls valid parses, and the key provider then has no
    // key for its stanzas (E001); a header failure is one here too.
    test(`CCTV age (parse only): ${name}`, async () => {
      let header;
      try {
        header = ageDecryptor.parseHeader(v.body, { maxScryptWorkFactor: 22 });
      } catch (err) {
        assert.ok(err instanceof AgeError && err.kind === 'header');
        assert.equal(v.expect, 'header failure');
        return;
      }
      await assert.rejects(ageDecryptor.decrypt(v.body, header, {}), (e) => e.kind === 'noKey');
    });
    continue;
  }
  test(`CCTV age: ${name}`, { skip: reason ?? false }, async () => {
    const got = await outcome(v);
    assert.equal(got.expect, v.expect);
    // A failure releases no plaintext at all, so only success compares the payload hash.
    if (v.expect === 'success') assert.equal(got.payload, v.payload);
  });
}

test('the work-factor limit refuses before running scrypt', async () => {
  const v = parseVector('scrypt');
  assert.throws(() => ageDecryptor.parseHeader(v.body, { maxScryptWorkFactor: 9 }), (e) => e.kind === 'header');
  // A limit that is not an integer in 1–22 never disables the check.
  for (const bad of [Number.NaN, 40, 0, 2.5]) {
    assert.throws(() => ageDecryptor.parseHeader(v.body, { maxScryptWorkFactor: bad }), (e) => e.kind === 'header');
  }
  // A spy: scrypt runs for a work factor within the limit, and never above it.
  let calls = 0;
  const spy = createAgeDecryptor({ scrypt: async () => { calls += 1; return Buffer.alloc(32); } });
  const header = spy.parseHeader(v.body, { maxScryptWorkFactor: 22 });
  await assert.rejects(spy.decrypt(v.body, header, { passphrase: 'x' }), (e) => e.kind === 'noMatch');
  assert.equal(calls, 1);
  assert.throws(() => spy.parseHeader(v.body, { maxScryptWorkFactor: Number(header.stanzas[0].args[1]) - 1 }));
  assert.equal(calls, 1);
});

test('decrypted bytes count against maxBytes, before any decryption, and exactly equal passes', async () => {
  const v = parseVector('stream_two_chunks');
  const header = ageDecryptor.parseHeader(v.body);
  await assert.rejects(ageDecryptor.decrypt(v.body, header, { identities: v.identities }, { maxBytes: 1000 }), (e) => e.kind === 'limit');
  const plain = await ageDecryptor.decrypt(v.body, header, { identities: v.identities });
  const exact = await ageDecryptor.decrypt(v.body, header, { identities: v.identities }, { maxBytes: plain.length });
  assert.equal(exact.length, plain.length);
  await assert.rejects(ageDecryptor.decrypt(v.body, header, { identities: v.identities }, { maxBytes: plain.length - 1 }), (e) => e.kind === 'limit');
});

test('the plaintext length comes from the ciphertext length; impossible lengths are refused', () => {
  const full = 64 * 1024 + 16;
  assert.equal(plaintextLength(16, Infinity), 0);
  assert.equal(plaintextLength(full, Infinity), 64 * 1024);
  assert.equal(plaintextLength(full + 17, Infinity), 64 * 1024 + 1);
  for (const bad of [0, 15, full + 16, full + 15]) assert.throws(() => plaintextLength(bad, Infinity), (e) => e.kind === 'payload');
  assert.throws(() => plaintextLength(full, 100), (e) => e.kind === 'limit');
});

test('the key provider result: wrong kinds are E001, wrong types and bad keys are E002, several kinds are all tried', async () => {
  const x = parseVector('x25519');
  const s = parseVector('scrypt');
  const xh = ageDecryptor.parseHeader(x.body);
  const sh = ageDecryptor.parseHeader(s.body, { maxScryptWorkFactor: 22 });
  const kind = (p) => p.then(() => 'ok', (e) => e.kind);
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, { passphrase: 'p' })), 'noKey');
  assert.equal(await kind(ageDecryptor.decrypt(s.body, sh, { identities: x.identities })), 'noKey');
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, null)), 'noKey');
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, 'AGE-SECRET-KEY-1')), 'noKey');
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, { identities: ['not an identity'] })), 'noMatch');
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, { identities: 'AGE-SECRET-KEY-1' })), 'noMatch');
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, { passphrase: 42 })), 'noMatch');
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, { fileKey: new Uint8Array(15) })), 'noMatch');
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, { fileKey: 'sixteen bytes!!!' })), 'noMatch');
  // A wrong file key first is no obstacle: identities are tried before it.
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, { fileKey: new Uint8Array(16), identities: x.identities })), 'ok');
  // A passphrase for an X25519 file beside the right identities: the identities open it.
  assert.equal(await kind(ageDecryptor.decrypt(x.body, xh, { passphrase: 'p', identities: x.identities })), 'ok');
});

test('the header holds at most 256 stanzas', () => {
  const stanza = '-> moca-pad x\n\n';
  const header = (n) => Buffer.from(`age-encryption.org/v1\n${stanza.repeat(n)}--- ${'A'.repeat(43)}\n${'\0'.repeat(16)}`, 'latin1');
  assert.throws(() => ageDecryptor.parseHeader(header(MAX_STANZAS + 1)), (e) => e.kind === 'header' && /more than 256/.test(e.message));
  // At the cap the parser goes on to the MAC line (the MAC itself is checked later, with a key).
  assert.doesNotThrow(() => ageDecryptor.parseHeader(header(MAX_STANZAS)));
});

test('identities are bech32-checked', () => {
  const good = 'AGE-SECRET-KEY-1EGTZVFFV20835NWYV6270LXYVK2VKNX2MMDKWYKLMGR48UAWX40Q2P2LM0';
  assert.equal(decodeIdentity(good)?.length, 32);
  assert.equal(decodeIdentity(good.slice(0, -1) + 'Q'), null);
  assert.equal(decodeIdentity(good.toLowerCase())?.length, 32);
  assert.equal(decodeIdentity('AGE-secret-KEY-1' + good.slice(16)), null);
});

// Every moca-spec envelope fixture decrypts to the same bytes with this module and with the Go age CLI.
const envelopes = join(spec, 'conformance/fixtures/envelopes');
const goAge = spawnSync('age', ['--version']).status === 0;
// CI installs the Go age CLI and sets MOCA_REQUIRE_GO_AGE, so this cross-check never skips there.
test('the Go age CLI is installed where it is required', { skip: !process.env.MOCA_REQUIRE_GO_AGE }, () => {
  assert.ok(goAge, 'MOCA_REQUIRE_GO_AGE is set, and `age` is not on the PATH');
});
test('envelope fixtures decrypt identically here and with the Go age CLI', { skip: !existsSync(envelopes) ? 'moca-spec is not beside this repository' : !goAge ? 'the Go age CLI is not installed' : false }, async () => {
  const identityFile = join(envelopes, 'keys/INSECURE-test.txt');
  const identities = readFileSync(identityFile, 'utf8').split('\n').filter((l) => l.startsWith('AGE-SECRET-KEY-1'));
  const passphrase = 'moca-conformance-INSECURE-passphrase';
  let compared = 0;
  for (const name of readdirSync(envelopes).filter((n) => n.endsWith('.moca.enc'))) {
    const entry = new AdmZip(join(envelopes, name)).getEntry('package.age');
    if (!entry) continue;
    const bytes = new Uint8Array(entry.getData());
    const usesScrypt = Buffer.from(bytes.subarray(0, 200)).toString('latin1').includes('-> scrypt');
    const go = usesScrypt
      ? spawnSync('age', ['--decrypt', '-j', 'batchpass'], { input: bytes, env: { ...process.env, AGE_PASSPHRASE: passphrase, AGE_PASSPHRASE_MAX_WORK_FACTOR: '22' } })
      : spawnSync('age', ['--decrypt', '-i', identityFile], { input: bytes });
    let ours;
    try {
      const header = ageDecryptor.parseHeader(bytes, { maxScryptWorkFactor: 22 });
      ours = await ageDecryptor.decrypt(bytes, header, usesScrypt ? { passphrase } : { identities });
    } catch (err) {
      if (!(err instanceof AgeError)) throw err;
      ours = null;
    }
    // The mixed-stanza fixture: Go age fails at the MAC, this module at the header. Both refuse it.
    assert.equal(ours !== null, go.status === 0, `${name}: this module ${ours ? 'decrypts' : 'refuses'}, Go age ${go.status === 0 ? 'decrypts' : 'refuses'}`);
    if (ours) assert.deepEqual(Buffer.from(ours), go.stdout, `${name}: the plaintexts differ`);
    compared += 1;
  }
  assert.ok(compared >= 15);
});
