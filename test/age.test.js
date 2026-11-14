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
import { ageDecryptor, AgeError, decodeIdentity } from '../lib/age.js';

const kit = fileURLToPath(new URL('./fixtures/cctv-age/', import.meta.url));
const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../moca-spec/', import.meta.url));

/** Why a vector is not run. Each reason is recorded in the 0.7.0 notes. */
function skipReason(v) {
  if (v.armored) return 'ASCII armor: envelopes carry binary age only (encrypted packages §4)';
  if (v.identities.some((i) => i.startsWith('AGE-SECRET-KEY-PQ-1'))) return 'hybrid (ML-KEM) identity: Readers unwrap X25519 and scrypt only; other stanzas go to the key provider (encrypted packages §4)';
  return null;
}

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
function outcome(v) {
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
      const plain = ageDecryptor.decrypt(v.body, header, key);
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
  test(`CCTV age: ${name}`, { skip: reason ?? false }, () => {
    const got = outcome(v);
    assert.equal(got.expect, v.expect);
    // A failure releases no plaintext at all, so only success compares the payload hash.
    if (v.expect === 'success') assert.equal(got.payload, v.payload);
  });
}

test('the work-factor limit refuses before running scrypt', () => {
  const v = parseVector('scrypt');
  assert.throws(() => ageDecryptor.parseHeader(v.body, { maxScryptWorkFactor: 9 }), (e) => e.kind === 'header');
});

test('decrypted bytes count against maxBytes', () => {
  const v = parseVector('stream_two_chunks');
  const header = ageDecryptor.parseHeader(v.body);
  assert.throws(() => ageDecryptor.decrypt(v.body, header, { identities: v.identities }, { maxBytes: 1000 }), (e) => e.kind === 'limit');
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
test('envelope fixtures decrypt identically here and with the Go age CLI', { skip: !existsSync(envelopes) ? 'moca-spec is not beside this repository' : !goAge ? 'the Go age CLI is not installed' : false }, () => {
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
      ours = ageDecryptor.decrypt(bytes, header, usesScrypt ? { passphrase } : { identities });
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
