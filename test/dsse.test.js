import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, verifyEnvelope, preAuthEncode, packageStatement, readPackage, PAYLOAD_TYPE } from '../lib/index.js';

// Attestations §5: DSSE keys are Ed25519. A trusted key of another type verifies nothing.
const pem = ({ privateKey, publicKey }) => ({
  privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
});
const ed25519 = pem(generateKeyPairSync('ed25519'));
const others = {
  'an RSA': pem(generateKeyPairSync('rsa', { modulusLength: 2048 })),
  'an ECDSA P-256': pem(generateKeyPairSync('ec', { namedCurve: 'P-256' })),
};
const payload = Buffer.from('{"_type":"https://in-toto.io/Statement/v1"}');

// What another implementation would write for a non-Ed25519 key: the PAE signed with SHA-256.
function foreignEnvelope(keys, keyid, body = payload) {
  const sig = sign('sha256', preAuthEncode(PAYLOAD_TYPE, body), keys.privateKeyPem).toString('base64');
  return { payload: body.toString('base64'), payloadType: PAYLOAD_TYPE, signatures: [{ keyid, sig }] };
}

test('an Ed25519 envelope verifies against its key', () => {
  const envelope = createEnvelope({ payload, payloadType: PAYLOAD_TYPE, privateKeyPem: ed25519.privateKeyPem, keyid: 'k' });
  assert.equal(verifyEnvelope({ envelope, resolvePublicKey: () => ed25519.publicKeyPem }).ok, true);
});

for (const [kind, keys] of Object.entries(others)) {
  test(`${kind} key cannot sign an envelope`, () => {
    assert.throws(
      () => createEnvelope({ payload, payloadType: PAYLOAD_TYPE, privateKeyPem: keys.privateKeyPem, keyid: 'k' }),
      /Ed25519/,
    );
  });

  test(`${kind} signature does not verify, even when its key is trusted`, () => {
    const result = verifyEnvelope({ envelope: foreignEnvelope(keys, 'k'), resolvePublicKey: () => keys.publicKeyPem });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no signature verified against a trusted key');
  });
}

test('a package signed with a trusted RSA key is not signed, and the attestation is invalid (A002)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moca-dsse-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/t', version: '1.0.0', title: 'T' }));
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'content', 'a.md'), '---\ntype: Note\ntitle: A\n---\n\n# A\n');
  const { digest } = await readPackage(dir);
  const statement = Buffer.from(JSON.stringify(packageStatement({ id: 'https://example.com/t', version: '1.0.0', digest })));
  mkdirSync(join(dir, 'attestations'));
  writeFileSync(join(dir, 'attestations', 'package.rsa.dsse.json'), JSON.stringify(foreignEnvelope(others['an RSA'], 'rsa', statement)));

  const trustRoot = { keys: [{ keyid: 'rsa', publicKey: others['an RSA'].publicKeyPem, roles: ['package'] }] };
  const pkg = await readPackage(dir, { trustRoot });
  assert.equal(pkg.valid, true);
  assert.equal(pkg.capabilities.includes('signed'), false);
  assert.deepEqual(pkg.diagnostics.map((d) => d.code), ['A002_ATTESTATION_INVALID']);
});

// Attestations §6–§7 (0.6): strict base64 and trust-root rules.
test('DSSE base64 accepts both alphabets, with or without padding, and nothing else', async () => {
  const { decodeBase64 } = await import('../lib/dsse.js');
  assert.equal(decodeBase64('aGk=').toString(), 'hi');
  assert.equal(decodeBase64('aGk').toString(), 'hi');
  assert.deepEqual(decodeBase64('_-8'), decodeBase64('/+8='));
  for (const bad of ['aG k=', 'a', 'aGk==', 'aGk=x', '!!!!']) assert.equal(decodeBase64(bad), null, bad);
});

test('a trust root with a repeated keyid or a key without roles is refused', async () => {
  const { loadTrustRoot } = await import('../lib/attestations.js');
  const key = { keyid: 'k', publicKey: 'x', roles: ['package'] };
  assert.throws(() => loadTrustRoot({ keys: [key, { ...key }] }), /appears more than once/);
  assert.throws(() => loadTrustRoot({ keys: [{ keyid: 'k', publicKey: 'x' }] }), /invalid trust root/);
  assert.equal(loadTrustRoot({ keys: [{ ...key, roles: [] }] }).key('k', 'package'), undefined);
});
