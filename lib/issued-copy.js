// Attestations §3a and §7.1: issued copies, pass 1.
import { ed25519KeyBytes, PREDICATE_ISSUED_COPY, scopeCovers } from './attestations.js';
import { manifestText, sha256Hex } from './digest.js';
import { PROFILE_ONTOLOGY } from './profiles.js';

const HEX64 = /^[0-9a-f]{64}$/;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Files the profiles this Reader recognises define (package spec §9): the ontology profile's `files`. */
function profileFiles(manifest) {
  const files = manifest?.profiles?.[PROFILE_ONTOLOGY]?.files;
  return new Set(Array.isArray(files) ? files.map((f) => f?.path).filter((p) => typeof p === 'string').map((p) => p.normalize('NFC')) : []);
}

/** Package spec §4.11: whether the publisher's `issuers` list the signer that verified the attestation. */
function issuerAllowed(issuers, sig) {
  const signed = sig.publicKey ? ed25519KeyBytes(sig.publicKey) : null;
  return issuers.some((entry) => {
    if (typeof entry?.publicKey === 'string' && signed) {
      const listed = ed25519KeyBytes(entry.publicKey);
      return listed !== null && listed.equals(signed);
    }
    if (entry?.sigstore && sig.sigstore) return entry.sigstore.issuer === sig.sigstore.issuer && entry.sigstore.subject === sig.sigstore.subject;
    return false;
  });
}

/** Package spec §4.11: a file entry allows that file; a directory entry (ending in /) allows every file under it. */
const pathAllowed = (paths, path) => paths.some((p) => (p.endsWith('/') ? path.startsWith(p.normalize('NFC')) : path === p.normalize('NFC')));

/**
 * Attestations §7.1, pass 1, after the signature verified with role issued-copy.
 * @param {object} statement
 * @param {{ ids: string[], publicKey?: string, sigstore?: { issuer: string, subject: string } }} sig
 * @param {{ manifest: object, digest: string, fileDigests: Map<string, string>, manifestValid: boolean }} pkg
 * @returns {{ error: string } | { original: string, changed: Map<string, string> }}
 *   original is `sha256:<hex>`; changed maps each NFC path to the publisher's hash
 */
export function checkIssuedCopy(statement, sig, { manifest, digest, fileDigests, manifestValid }) {
  if (statement.predicateType !== PREDICATE_ISSUED_COPY) return { error: 'not an issued-copy attestation' };
  const subject = statement.subject[0];
  if (statement.subject.length !== 1 || subject?.name !== `${manifest.id}@${manifest.version}`) {
    return { error: `subject "${subject?.name}" does not name ${manifest.id}@${manifest.version}` };
  }
  if (subject.digest?.sha256 !== digest.replace(/^sha256:/, '')) return { error: 'subject digest does not match the copy' };
  const p = statement.predicate;
  const original = p?.original?.sha256;
  if (typeof original !== 'string' || !HEX64.test(original)) return { error: 'original.sha256 is not a SHA-256 digest' };
  if (`sha256:${original}` === digest) return { error: 'original is the digest of the copy itself' };
  const listed = p?.changedFiles;
  if (!listed || typeof listed !== 'object' || Array.isArray(listed) || Object.keys(listed).length === 0) {
    return { error: 'changedFiles is missing or empty' };
  }
  // Attestations §7.1 step 2: the role needs ids that cover the package.
  if (!scopeCovers(sig.ids ?? [], manifest.id)) return { error: `the issuer's trust-root entry has no ids covering ${manifest.id}` };
  // Step 3: the publisher's consent. A manifest that failed its schema allows nothing.
  const consent = manifestValid ? manifest.issuedCopies : undefined;
  if (!consent) return { error: 'the publisher allows no issued copies (no issuedCopies in moca.json)' };
  if (!issuerAllowed(consent.issuers, sig)) return { error: "the issuer is not in the publisher's issuedCopies.issuers" };
  // Step 4: each changed file.
  const defined = profileFiles(manifest);
  const changed = new Map();
  for (const path of Object.keys(listed)) {
    const entry = listed[path];
    const hash = own(entry ?? {}, 'original') ? entry.original : undefined;
    if (path !== path.normalize('NFC')) return { error: `changedFiles key ${path} is not in NFC` };
    if (!/^(content|media)\//.test(path)) return { error: `${path} is not under content/ or media/` };
    if (path.split('/').some((seg) => seg.startsWith('.'))) return { error: `${path} is a hidden entry` };
    if (defined.has(path)) return { error: `${path} is a file a profile defines` };
    if (!fileDigests.has(path)) return { error: `${path} is not a file in the copy` };
    if (typeof hash !== 'string' || !HEX64.test(hash)) return { error: `${path}: original is not a SHA-256 hash` };
    if (fileDigests.get(path) === hash) return { error: `${path} is listed but unchanged` };
    if (!pathAllowed(consent.paths, path)) return { error: `${path} is outside the paths the publisher allows` };
    changed.set(path, hash);
  }
  // Step 5: rebuild the publisher's digest.
  if (rebuiltDigest(fileDigests, changed) !== `sha256:${original}`) return { error: 'the rebuilt digest does not equal original' };
  return { original: `sha256:${original}`, changed };
}

/**
 * Attestations §7.1 step 5: the digest of the copy's manifest with each changed file's original hash.
 * @param {Map<string, string>} fileDigests  NFC path -> hex, as the copy has them
 * @param {Map<string, string>} changed  NFC path -> the publisher's hex
 * @returns {string} `sha256:<hex>`
 */
export function rebuiltDigest(fileDigests, changed) {
  const rebuilt = new Map(fileDigests);
  for (const [path, hash] of changed) rebuilt.set(path, hash);
  return `sha256:${sha256Hex(Buffer.from(manifestText(rebuilt), 'utf8'))}`;
}

/** Whether two passing issued-copy results agree on original and changedFiles. */
export function sameIssuedCopy(a, b) {
  if (a.original !== b.original || a.changed.size !== b.changed.size) return false;
  for (const [path, hash] of a.changed) if (b.changed.get(path) !== hash) return false;
  return true;
}
