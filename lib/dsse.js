// DSSE (Dead Simple Signing Envelope) — https://github.com/secure-systems-lab/dsse
//
// Implements the Pre-Authentication Encoding (PAE) and envelope shape
// directly against Node's built-in crypto (Ed25519) rather than depending on
// a third-party DSSE library, since the encoding is a handful of lines and
// this keeps the "dsse" signature mode's trust chain auditable end to end.
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { strictEncodings } from './ed25519.js';

const PAE_PREFIX = 'DSSEv1';

/**
 * Attestations §7: DSSE payloads and signatures are base64 (RFC 4648 §4) or
 * base64url (§5), with or without padding. Anything else is not base64.
 *
 * @param {string} text
 * @returns {Buffer|null}
 */
export function decodeBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  const body = text.replace(/=+$/, '');
  if (body.length % 4 === 1) return null;
  if (text.length !== body.length && text.length % 4 !== 0) return null;
  return Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Pre-Authentication Encoding: DSSEv1 <len> <type> <len> <body>, space-separated,
 * lengths are the ASCII decimal byte length of the field that follows them.
 *
 * @param {string} payloadType
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function preAuthEncode(payloadType, payload) {
  const typeBuf = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`${PAE_PREFIX} ${typeBuf.length} `, 'utf8'),
    typeBuf,
    Buffer.from(` ${payload.length} `, 'utf8'),
    payload,
  ]);
}

/**
 * @param {object} params
 * @param {Buffer} params.payload - raw (not base64) payload bytes.
 * @param {string} params.payloadType
 * @param {string} params.privateKeyPem - Ed25519 private key, PEM-encoded (PKCS8).
 * @param {string} params.keyid
 * @returns {{ payload: string, payloadType: string, signatures: [{ keyid: string, sig: string }] }}
 */
export function createEnvelope({ payload, payloadType, privateKeyPem, keyid }) {
  const pae = preAuthEncode(payloadType, payload);
  const key = createPrivateKey(privateKeyPem);
  // Attestations §5: DSSE keys are Ed25519.
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('DSSE envelopes are signed with Ed25519 keys');
  const signature = cryptoSign(null, pae, key);
  return {
    payload: payload.toString('base64'),
    payloadType,
    signatures: [{ keyid, sig: signature.toString('base64') }],
  };
}

/**
 * @param {object} params
 * @param {object} params.envelope - a DSSE envelope as produced by createEnvelope.
 * @param {(keyid: string) => string|undefined} params.resolvePublicKey - returns
 *   a PEM (SPKI) public key for the given keyid, or undefined if unknown/untrusted.
 * @returns {{ ok: true, payload: Buffer, payloadType: string, keyid: string } | { ok: false, reason: string }}
 */
export function verifyEnvelope({ envelope, resolvePublicKey }) {
  if (
    !envelope
    || typeof envelope !== 'object'
    || typeof envelope.payload !== 'string'
    || typeof envelope.payloadType !== 'string'
    || !Array.isArray(envelope.signatures)
    || envelope.signatures.length === 0
  ) {
    return { ok: false, reason: 'malformed DSSE envelope' };
  }

  const payload = decodeBase64(envelope.payload);
  if (!payload) return { ok: false, reason: 'envelope payload is not valid base64' };
  const pae = preAuthEncode(envelope.payloadType, payload);

  for (const entry of envelope.signatures) {
    if (typeof entry?.keyid !== 'string' || typeof entry?.sig !== 'string') continue;
    const publicKeyPem = resolvePublicKey(entry.keyid);
    if (!publicKeyPem) continue;
    const signature = decodeBase64(entry.sig);
    if (!signature) continue;
    let ok = false;
    try {
      const key = createPublicKey(publicKeyPem);
      // Attestations §5: only an Ed25519 key verifies. A trusted key of any other type verifies nothing.
      // Strict encodings first, so every Reader's library reaches the same answer.
      ok = key.asymmetricKeyType === 'ed25519'
        && strictEncodings(Buffer.from(key.export({ format: 'jwk' }).x, 'base64url'), signature)
        && cryptoVerify(null, pae, key, signature);
    } catch {
      ok = false;
    }
    if (ok) {
      return { ok: true, payload, payloadType: envelope.payloadType, keyid: entry.keyid };
    }
  }

  return { ok: false, reason: 'no signature verified against a trusted key' };
}
