// @openmoca/moca-core/age: decrypt-only age v1 (https://c2sp.org/age) for encrypted packages
// (moca-spec encrypted packages §4). X25519 and scrypt recipients only; no plugins, no armor, no encryption.
//
// This module is separate from the core on purpose: the core never imports it. A host that wants the optional
// feature `encryption` passes `ageDecryptor` to readPackage as `decryptor`. It uses node:crypto only, so a port to
// another runtime replaces this one file.
//
// Nothing here releases plaintext before the whole payload has authenticated.
import {
  createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, scryptSync, timingSafeEqual,
} from 'node:crypto';

const VERSION_LINE = 'age-encryption.org/v1';
const MAX_HEADER_BYTES = 64 * 1024;
const CHUNK = 64 * 1024;
const TAG = 16;
const X25519_LABEL = 'age-encryption.org/v1/X25519';
const SCRYPT_LABEL = 'age-encryption.org/v1/scrypt';
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const B64 = /^[A-Za-z0-9+/]*$/;

/**
 * Why decryption stopped. `kind` maps to the encrypted-package codes in the Reader:
 * `header` (E006), `noKey` (E001), `noMatch` and `mac` (E002), `payload` (E003), `limit` (T003).
 */
export class AgeError extends Error {
  /** @param {'header'|'noKey'|'noMatch'|'mac'|'payload'|'limit'} kind @param {string} message */
  constructor(kind, message) {
    super(message);
    this.name = 'AgeError';
    this.kind = kind;
  }
}

const fail = (kind, message) => { throw new AgeError(kind, message); };

/** Canonical, unpadded standard base64 (age spec): no padding, and unused bits zero. */
function decodeB64(text, what) {
  if (!B64.test(text) || text.length % 4 === 1) fail('header', `${what} is not canonical unpadded base64`);
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== text) fail('header', `${what} is not canonical base64`);
  return bytes;
}

/** A visible ASCII argument: 1 or more of %x21-7E. */
const isArg = (s) => s.length > 0 && /^[\x21-\x7e]+$/.test(s);

/**
 * Parses an age v1 header strictly. Throws AgeError('header') on any deviation, an scrypt stanza that is not alone,
 * a work factor over `maxScryptWorkFactor`, a malformed X25519 or scrypt stanza, or a header over 64 KiB.
 * @param {Uint8Array} bytes  the whole age file
 * @param {{ maxScryptWorkFactor?: number }} [options]
 * @returns {{ stanzas: { type: string, args: string[], body: Uint8Array }[], headerNoMac: Buffer, mac: Buffer, payloadStart: number }}
 */
export function parseHeader(bytes, { maxScryptWorkFactor = 20 } = {}) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const line = () => {
    const end = buf.indexOf(0x0a, pos);
    if (end < 0 || end >= MAX_HEADER_BYTES) fail('header', end < 0 ? 'the header is not terminated' : 'the header is over 64 KiB');
    const text = buf.subarray(pos, end).toString('latin1');
    if (!/^[\x20-\x7e]*$/.test(text)) fail('header', 'the header has a character outside printable ASCII');
    const start = pos;
    pos = end + 1;
    return { text, start };
  };

  if (line().text !== VERSION_LINE) fail('header', 'not an age v1 file');
  const stanzas = [];
  for (;;) {
    const { text, start } = line();
    if (text.startsWith('--- ')) {
      const mac = decodeB64(text.slice(4), 'the header MAC');
      if (mac.length !== 32) fail('header', 'the header MAC is not 32 bytes');
      if (stanzas.length === 0) fail('header', 'the header has no recipient stanza');
      checkStanzas(stanzas, maxScryptWorkFactor);
      // The 16-byte payload nonce belongs to the header for failure purposes (the C2SP test kit agrees).
      if (buf.length - pos < 16) fail('header', 'the payload nonce is missing or short');
      return { stanzas, headerNoMac: buf.subarray(0, start + 3), mac, payloadStart: pos };
    }
    if (!text.startsWith('-> ')) fail('header', 'expected a stanza or the MAC line');
    const args = text.slice(3).split(' ');
    if (!args.every(isArg)) fail('header', 'a stanza argument is empty or has a character outside %x21-7E');
    // The body: full 64-column lines, then one shorter (possibly empty) final line.
    const chunks = [];
    for (;;) {
      const body = line().text;
      if (body.length > 64) fail('header', 'a stanza body line is longer than 64 columns');
      chunks.push(body);
      if (body.length < 64) break;
    }
    stanzas.push({ type: args[0], args: args.slice(1), body: new Uint8Array(decodeB64(chunks.join(''), 'a stanza body')) });
  }
}

function checkStanzas(stanzas, maxScryptWorkFactor) {
  const scrypt = stanzas.filter((s) => s.type === 'scrypt');
  if (scrypt.length > 0 && stanzas.length !== 1) fail('header', 'an scrypt stanza must be the only stanza');
  for (const s of stanzas) {
    if (s.type === 'X25519') {
      if (s.args.length !== 1) fail('header', 'an X25519 stanza takes one argument');
      if (decodeB64(s.args[0], 'an X25519 share').length !== 32) fail('header', 'an X25519 share is not 32 bytes');
      if (s.body.length !== 32) fail('header', 'an X25519 stanza body is not 32 bytes');
    } else if (s.type === 'scrypt') {
      if (s.args.length !== 2) fail('header', 'an scrypt stanza takes two arguments');
      if (decodeB64(s.args[0], 'an scrypt salt').length !== 16) fail('header', 'an scrypt salt is not 16 bytes');
      if (!/^[1-9][0-9]*$/.test(s.args[1]) || s.args[1].length > 2) fail('header', 'an scrypt work factor is not a decimal number');
      const workFactor = Number(s.args[1]);
      if (workFactor > maxScryptWorkFactor) fail('header', `the scrypt work factor ${workFactor} is over the limit of ${maxScryptWorkFactor}`);
      if (s.body.length !== 32) fail('header', 'an scrypt stanza body is not 32 bytes');
    }
  }
}

const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

/** ChaCha20-Poly1305 open; null when authentication fails. */
function open(key, nonce, sealed) {
  if (sealed.length < TAG) return null;
  try {
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
    d.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
  } catch {
    return null;
  }
}

const ZERO_NONCE = Buffer.alloc(12);

// Bech32 (BIP 173), for AGE-SECRET-KEY-1… identities.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
  }
  return chk;
}
/** The 32-byte X25519 scalar of an age identity, or null when it is not a valid one. */
export function decodeIdentity(text) {
  if (typeof text !== 'string' || (text !== text.toUpperCase() && text !== text.toLowerCase())) return null;
  const s = text.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (s.slice(0, sep) !== 'age-secret-key-') return null;
  const data = [...s.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.length < 6 || data.some((d) => d < 0)) return null;
  const hrp = s.slice(0, sep);
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...expanded, ...data]) !== 1) return null;
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0 || out.length !== 32) return null;
  return Buffer.from(out);
}

function unwrapX25519(stanzas, identities) {
  const keys = identities.map((id) => {
    const scalar = decodeIdentity(id);
    if (!scalar) fail('noMatch', 'an identity from the key provider is not a valid AGE-SECRET-KEY-1 identity');
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, scalar]), format: 'der', type: 'pkcs8' });
    const recipient = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
    return { privateKey, recipient };
  });
  for (const s of stanzas.filter((x) => x.type === 'X25519')) {
    const share = Buffer.from(s.args[0], 'base64');
    const publicKey = createPublicKey({ key: Buffer.concat([SPKI_X25519, share]), format: 'der', type: 'spki' });
    for (const { privateKey, recipient } of keys) {
      let shared;
      try {
        shared = diffieHellman({ privateKey, publicKey });
      } catch {
        shared = Buffer.alloc(32);
      }
      // A low-order share gives the all-zero secret, which age forbids (constant-time check).
      if (timingSafeEqual(shared, Buffer.alloc(32))) fail('header', 'an X25519 share is a low-order point');
      const wrapKey = hkdf(shared, Buffer.concat([share, recipient]), X25519_LABEL);
      const fileKey = open(wrapKey, ZERO_NONCE, Buffer.from(s.body));
      if (fileKey && fileKey.length === 16) return fileKey;
    }
  }
  return fail('noMatch', 'no identity unwraps an X25519 stanza');
}

function unwrapScrypt(stanza, passphrase) {
  const salt = Buffer.concat([Buffer.from(SCRYPT_LABEL), Buffer.from(stanza.args[0], 'base64')]);
  const N = 2 ** Number(stanza.args[1]);
  const key = scryptSync(Buffer.from(passphrase, 'utf8'), salt, 32, { N, r: 8, p: 1, maxmem: 129 * 8 * N + 1024 * 1024 });
  const fileKey = open(key, ZERO_NONCE, Buffer.from(stanza.body));
  return fileKey && fileKey.length === 16 ? fileKey : fail('noMatch', 'the passphrase does not unwrap the scrypt stanza');
}

/**
 * Unwraps the file key with what the key provider returned. Throws AgeError: `noKey` when the key is of a kind
 * no stanza uses (or is missing), `noMatch` when it is of the right kind but fails.
 * @param {{ stanzas: {type: string, args: string[], body: Uint8Array}[] }} header
 * @param {{ identities?: string[], passphrase?: string, fileKey?: Uint8Array } | null | undefined} key
 */
export function unwrapFileKey(header, key) {
  if (key && key.fileKey instanceof Uint8Array) {
    if (key.fileKey.length !== 16) fail('noMatch', 'the file key from the key provider is not 16 bytes');
    return Buffer.from(key.fileKey);
  }
  if (key && Array.isArray(key.identities) && key.identities.length > 0) {
    if (!header.stanzas.some((s) => s.type === 'X25519')) fail('noKey', 'the key provider returned identities, and the file has no X25519 stanza');
    return unwrapX25519(header.stanzas, key.identities);
  }
  if (key && typeof key.passphrase === 'string') {
    const stanza = header.stanzas.find((s) => s.type === 'scrypt');
    if (!stanza) fail('noKey', 'the key provider returned a passphrase, and the file has no scrypt stanza');
    return unwrapScrypt(stanza, key.passphrase);
  }
  return fail('noKey', 'the key provider returned no key');
}

/** Verifies the header MAC with a constant-time compare. Throws AgeError('mac'). */
export function verifyMac(header, fileKey) {
  const mac = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(header.headerNoMac).digest();
  if (!timingSafeEqual(mac, header.mac)) fail('mac', 'the header MAC does not verify');
}

/**
 * Decrypts and authenticates the whole STREAM payload. Throws AgeError('payload') on any failure, and
 * AgeError('limit') once the plaintext passes `maxBytes`. Returns nothing until every chunk has authenticated.
 * @param {Uint8Array} bytes  the whole age file
 * @param {{ payloadStart: number }} header
 * @param {Buffer} fileKey
 * @param {{ maxBytes?: number }} [options]
 */
export function decryptPayload(bytes, header, fileKey, { maxBytes = Infinity } = {}) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nonce = buf.subarray(header.payloadStart, header.payloadStart + 16);
  const key = hkdf(fileKey, nonce, 'payload');
  const out = [];
  let produced = 0;
  let pos = header.payloadStart + 16;
  for (let counter = 0; ; counter++) {
    const remaining = buf.length - pos;
    const last = remaining <= CHUNK + TAG;
    const sealed = buf.subarray(pos, last ? buf.length : pos + CHUNK + TAG);
    const chunkNonce = Buffer.alloc(12);
    chunkNonce.writeUIntBE(counter, 5, 6);
    chunkNonce[11] = last ? 1 : 0;
    const plain = open(key, chunkNonce, sealed);
    if (!plain) fail('payload', last ? 'the final chunk does not authenticate, or is missing' : `chunk ${counter} does not authenticate`);
    if (last && plain.length === 0 && counter > 0) fail('payload', 'an empty final chunk follows a full chunk');
    produced += plain.length;
    if (produced > maxBytes) fail('limit', `the decrypted payload is over ${maxBytes} bytes`);
    out.push(plain);
    if (last) return new Uint8Array(Buffer.concat(out));
    pos += CHUNK + TAG;
  }
}

/**
 * The decryptor a host passes to readPackage (`decryptor`) to enable the optional feature `encryption`.
 * The Reader calls parseHeader, then its key provider with the stanzas, then decrypt.
 */
export const ageDecryptor = Object.freeze({
  parseHeader,
  /** @param {Uint8Array} bytes @param {ReturnType<typeof parseHeader>} header @param {object} key @param {{ maxBytes?: number }} [options] */
  decrypt(bytes, header, key, options = {}) {
    const fileKey = unwrapFileKey(header, key);
    verifyMac(header, fileKey);
    return decryptPayload(bytes, header, fileKey, options);
  },
});
