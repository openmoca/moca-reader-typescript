// Detached attestations: spec/moca-attestations.md.
//
// A package carries its attestations under attestations/, which the canonical
// digest excludes. Each file is either a DSSE envelope (*.dsse.json) or a
// Sigstore bundle (*.sigstore.json) wrapping an in-toto v1 Statement with one
// of two MOCA predicate types:
//
//   package/v1  "this exact package was published by this signer"
//   review/v1   "this reviewer checked these exact node files"
import { duplicateKey } from './json-strict.js';
import { parseInstant } from './dates.js';
import { readFileSync } from 'node:fs';
import { decodeBase64, verifyEnvelope } from './dsse.js';
import { validateAgainst } from './schemas.js';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const PREDICATE_PACKAGE = 'https://w3id.org/moca/attestation/package/v1';
export const PREDICATE_REVIEW = 'https://w3id.org/moca/attestation/review/v1';

const hexOf = (digest) => digest.replace(/^sha256:/, '');

/** @returns {object} in-toto Statement for a package attestation */
export function packageStatement({ id, version, digest }) {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: `${id}@${version}`, digest: { sha256: hexOf(digest) } }],
    predicateType: PREDICATE_PACKAGE,
    predicate: {},
  };
}

/**
 * @param {{ packageId: string, files: Array<{ path: string, sha256: string }>, reviewer: string, reviewedAt: string, outcome: string, scope?: string, note?: string }} p
 * @returns {object} in-toto Statement for a review attestation
 */
export function reviewStatement({ packageId, files, reviewer, reviewedAt, outcome, scope, note }) {
  const predicate = { package: packageId, reviewer, reviewedAt, outcome };
  if (scope) predicate.scope = scope;
  if (note) predicate.note = note;
  return {
    _type: STATEMENT_TYPE,
    subject: files.map((f) => ({ name: f.path, digest: { sha256: f.sha256 } })),
    predicateType: PREDICATE_REVIEW,
    predicate,
  };
}

/**
 * Loads a host trust root (spec/moca-attestations.md §6) from a path or object.
 *
 * @param {string|object} input
 */
export function loadTrustRoot(input) {
  const doc = typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) : input;
  const errors = validateAgainst('trustRoot', doc);
  if (errors.length > 0) throw new Error(`invalid trust root: ${errors.join('; ')}`);
  // Attestations §6: keyids are unique, and `roles` is required (an empty list trusts nothing).
  const keys = new Map();
  for (const k of doc.keys ?? []) {
    if (keys.has(k.keyid)) throw new Error(`invalid trust root: keyid "${k.keyid}" appears more than once`);
    keys.set(k.keyid, k);
  }
  const allows = (entry, role) => Array.isArray(entry.roles) && entry.roles.includes(role);
  return {
    doc,
    /** @returns {{ publicKey: string, identity: string } | undefined} */
    key(keyid, role, now = new Date()) {
      const entry = keys.get(keyid);
      if (!entry || !allows(entry, role)) return undefined;
      // Attestations §6: a key is not trusted from the instant it expires; one whose
      // expiry does not parse is not trusted at all.
      if (entry.expires !== undefined && !(now.getTime() < parseInstant(entry.expires))) return undefined;
      return { publicKey: entry.publicKey, identity: entry.identity ?? keyid, ids: Array.isArray(entry.ids) ? entry.ids : [], reviewers: Array.isArray(entry.reviewers) ? entry.reviewers : undefined };
    },
    sigstoreIdentities(role) {
      return (doc.sigstore?.identities ?? []).filter((i) => allows(i, role));
    },
  };
}

/**
 * Parses an attestation file into its envelope and statement.
 *
 * @param {string} path
 * @param {Buffer} bytes
 * @returns {{ ok: true, format: 'dsse'|'sigstore', container: object, statement: object } | { ok: false, reason: string }}
 */
export function parseAttestation(path, bytes) {
  const format = path.endsWith('.sigstore.json') ? 'sigstore' : path.endsWith('.dsse.json') ? 'dsse' : null;
  if (!format) return { ok: false, reason: 'attestation files must end in .dsse.json or .sigstore.json' };
  let container;
  try {
    container = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  const envelope = format === 'dsse' ? container : container?.dsseEnvelope;
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.payloadType !== 'string') {
    return { ok: false, reason: format === 'dsse' ? 'not a DSSE envelope' : 'Sigstore bundle has no dsseEnvelope' };
  }
  if (envelope.payloadType !== PAYLOAD_TYPE) return { ok: false, reason: `unexpected payloadType ${envelope.payloadType}` };
  const payload = decodeBase64(envelope.payload);
  if (!payload) return { ok: false, reason: 'payload is not base64 or base64url' };
  let statement;
  try {
    const text = payload.toString('utf8');
    statement = JSON.parse(text);
    if (duplicateKey(text) !== null) return { ok: false, reason: 'the statement repeats a member name' };
  } catch {
    return { ok: false, reason: 'payload is not a JSON in-toto statement' };
  }
  if (statement?._type !== STATEMENT_TYPE || !Array.isArray(statement.subject) || typeof statement.predicateType !== 'string') {
    return { ok: false, reason: 'payload is not an in-toto v1 Statement' };
  }
  return { ok: true, format, container, statement };
}

/**
 * Verifies the signature on a parsed attestation against the host trust root.
 * It does not check what the statement says; see checkPackageStatement and
 * checkReviewStatement for that.
 *
 * @param {{ format: string, container: object }} parsed
 * @param {ReturnType<typeof loadTrustRoot>|undefined} trustRoot
 * @param {'package'|'review'} role
 * @param {{ now?: Date, online?: boolean, allowOfflineFallback?: boolean, tufCachePath?: string }} [options]
 * @returns {Promise<{ outcome: 'valid'|'invalid'|'unverifiable'|'indeterminate', signer?: string, reason?: string }>}
 */
export async function verifySignature(parsed, trustRoot, role, options = {}) {
  if (!trustRoot) return { outcome: 'unverifiable', reason: 'no trust root was supplied' };
  // The host's clock (Reader interface §3), checked when keys expire.
  const now = options.clock ? options.clock() : (options.now ?? new Date());

  if (parsed.format === 'dsse') {
    let signer;
    const result = verifyEnvelope({
      envelope: parsed.container,
      resolvePublicKey: (keyid) => {
        const k = trustRoot.key(keyid, role, now);
        if (k) signer = k.identity;
        return k?.publicKey;
      },
    });
    if (!result.ok) return { outcome: 'invalid', reason: result.reason };
    const k = trustRoot.key(result.keyid, role, now);
    return { outcome: 'valid', signer: k?.identity ?? signer ?? result.keyid, ids: k?.ids ?? [], reviewers: k?.reviewers };
  }

  // Attestations §7: unverifiable only when the trust root lists no Sigstore
  // identities at all; identities that exist but are not trusted for this role
  // make the attestation invalid, as an untrusted DSSE key does.
  if ((trustRoot.doc.sigstore?.identities ?? []).length === 0) {
    return { outcome: 'unverifiable', reason: 'the trust root lists no Sigstore identities' };
  }
  const identities = trustRoot.sigstoreIdentities(role);
  if (identities.length === 0) {
    return { outcome: 'invalid', reason: `no Sigstore identity in the trust root is trusted for the ${role} role` };
  }
  // Attestations §6: a host-supplied trusted root is the only trust material, used offline; nothing is fetched.
  const trustedRoot = trustRoot.doc.sigstore?.trustedRoot;
  if (trustedRoot !== undefined) return verifyWithTrustedRoot(parsed, trustedRoot, identities);
  const { verify } = await import('sigstore');
  // Contract §6: offline is the default. Without `online`, Sigstore's trust material
  // comes from the TUF cache (seeded from the copy bundled with the library) and
  // is never refreshed over the network.
  const base = { tufForceCache: !options.online, ...(options.tufCachePath ? { tufCachePath: options.tufCachePath } : {}) };
  let lastError;
  for (const { issuer, subject, ids, reviewers } of identities) {
    const constraint = subject.includes('@') && !subject.includes('://')
      ? { certificateIdentityEmail: subject }
      : { certificateIdentityURI: subject };
    try {
      await verify(parsed.container, { ...base, certificateIssuer: issuer, ...constraint });
      return { outcome: 'valid', signer: `${issuer} ${subject}`, ids: Array.isArray(ids) ? ids : [], reviewers: Array.isArray(reviewers) ? reviewers : undefined };
    } catch (err) {
      lastError = err;
    }
  }
  const message = lastError?.message ?? 'verification failed';
  const unreachable = /network|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|timeout|TUF_/i.test(message);
  if (!options.online && unreachable) {
    return { outcome: 'unverifiable', reason: `offline Sigstore trust material is unavailable: ${message}` };
  }
  if (options.online && unreachable) {
    if (options.allowOfflineFallback) return verifySignature(parsed, trustRoot, role, { ...options, online: false, allowOfflineFallback: false });
    return { outcome: 'indeterminate', reason: `online verification could not complete: ${message}` };
  }
  return { outcome: 'invalid', reason: message };
}

async function verifyWithTrustedRoot(parsed, trustedRoot, identities) {
  const [{ Verifier, toTrustMaterial, toSignedEntity }, { bundleFromJSON }, { TrustedRoot }] = await Promise.all([
    import('@sigstore/verify'), import('@sigstore/bundle'), import('@sigstore/protobuf-specs'),
  ]);
  let verifier;
  try {
    verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trustedRoot)));
  } catch (err) {
    // Attestations §7, step 6: an unusable trusted root leaves no trust material.
    return { outcome: 'unverifiable', reason: `sigstore.trustedRoot cannot be used: ${err.message}` };
  }
  let entity;
  try {
    entity = toSignedEntity(bundleFromJSON(parsed.container));
  } catch (err) {
    return { outcome: 'invalid', reason: `not a valid Sigstore bundle: ${err.message}` };
  }
  let lastError;
  for (const { issuer, subject, ids, reviewers } of identities) {
    try {
      // Attestations §6: issuer and subject alternative name match exactly; no patterns.
      verifier.verify(entity, { subjectAlternativeName: subject, extensions: { issuer } });
      return { outcome: 'valid', signer: `${issuer} ${subject}`, ids: Array.isArray(ids) ? ids : [], reviewers: Array.isArray(reviewers) ? reviewers : undefined };
    } catch (err) {
      lastError = err;
    }
  }
  return { outcome: 'invalid', reason: lastError?.message ?? 'verification failed' };
}

/** @returns {string|null} reason the statement does not attest this package, or null */
export function checkPackageStatement(statement, { id, version, digest }) {
  if (statement.predicateType !== PREDICATE_PACKAGE) return 'not a package attestation';
  const subject = statement.subject[0];
  if (statement.subject.length !== 1 || subject?.name !== `${id}@${version}`) {
    return `subject "${subject?.name}" does not name ${id}@${version}`;
  }
  if (subject.digest?.sha256 !== hexOf(digest)) return 'subject digest does not match the package digest';
  return null;
}

/**
 * @param {object} statement
 * @param {string} packageId
 * @param {Map<string, string>} fileDigests  NFC path -> hex
 * @returns {{ error?: string, current: string[], outdated: string[], predicate?: object }}
 */
export function checkReviewStatement(statement, packageId, fileDigests) {
  const errors = validateAgainst('reviewPredicate', statement.predicate);
  if (errors.length > 0) return { error: `review predicate is invalid: ${errors.join('; ')}`, current: [], outdated: [] };
  if (statement.predicate.package !== packageId) {
    return { error: `review names package ${statement.predicate.package}, not ${packageId}`, current: [], outdated: [] };
  }
  const current = [];
  const outdated = [];
  for (const s of statement.subject) {
    if (typeof s?.name !== 'string' || typeof s?.digest?.sha256 !== 'string') {
      return { error: 'review subject entries need a name and a sha256 digest', current: [], outdated: [] };
    }
    if (fileDigests.get(s.name.normalize('NFC')) === s.digest.sha256) current.push(s.name);
    else outdated.push(s.name);
  }
  return { current, outdated, predicate: statement.predicate };
}

/**
 * Package spec §7.2: whether a signer's `ids` scope covers a package id. An
 * entry matches exactly, or as a prefix when it ends in `/`, `:` or `#`.
 * @param {string[]} scopes
 * @param {string} id
 */
export function scopeCovers(scopes, id) {
  return typeof id === 'string' && scopes.some((s) => s === id || (/[/:#]$/.test(s) && id.startsWith(s)));
}
