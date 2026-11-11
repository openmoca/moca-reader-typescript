// The package digest, moca-digest-v2: spec/moca-package-spec.md §6.
//
// The digest identifies a package's content independently of how it is
// stored or transported: the same package as a directory, a .moca archive or
// a host source has the same digest. It is computed, never declared inside
// the package: a digest a package states about itself proves nothing, so it
// is only ever compared with a reference held elsewhere (an attestation, a
// member pin, a sidecar binding).
//
// The digest is the SHA-256 of a BagIt-style payload manifest
// (RFC 8493 manifest-sha256.txt), so `sha256sum -c` can check a package.
import { createHash } from 'node:crypto';
import { simpleLowercase } from './unicode.js';

export const DIGEST_ALGORITHM = 'moca-digest-v2';
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const MANIFEST = 'moca.json';
export const ATTESTATIONS_DIR = 'attestations';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when a path belongs to the attestations area, which the digest excludes. */
export function isAttestationPath(path) {
  // Only entries under the attestations/ directory; a top-level file named
  // `attestations` is ordinary package content and is digested.
  return path.startsWith(`${ATTESTATIONS_DIR}/`);
}

/**
 * Checks every entry of a source and returns the regular files that make up
 * the package, keyed by their NFC-normalised path. Records P001-P003 and
 * returns ok=false if any entry makes the package's identity ambiguous.
 *
 * @param {import('./source.js').PackageSource} source
 * @param {import('./diagnostics.js').Diagnostics} diagnostics
 * @returns {{ ok: boolean, files: Map<string, string> }} NFC path -> stored path
 */
export function packageFiles(source, diagnostics) {
  const files = new Map();
  const folded = new Map();
  let ok = true;
  for (const entry of source.list()) {
    if (entry.kind === 'symlink' || entry.kind === 'other') {
      diagnostics.add('P001_UNSUPPORTED_ENTRY', `"${entry.path}" is a ${entry.kind === 'symlink' ? 'symbolic link' : 'non-regular file'}; packages may contain regular files only`, { file: entry.path });
      ok = false;
      continue;
    }
    if (entry.kind === 'unreadable') {
      diagnostics.add('P002_UNREADABLE_ENTRY', `"${entry.path}" could not be read`, { file: entry.path });
      ok = false;
      continue;
    }
    const nfc = entry.path.normalize('NFC');
    const key = simpleLowercase(nfc);
    if (folded.has(key)) {
      diagnostics.add('P003_PATH_COLLISION', `"${entry.path}" collides with "${folded.get(key)}" after NFC normalisation or case folding`, { file: entry.path });
      ok = false;
      continue;
    }
    folded.set(key, entry.path);
    files.set(nfc, entry.path);
  }
  return { ok, files };
}

/** A path as it appears in a BagIt manifest line: CR, LF and % percent-encoded (RFC 8493 §2.1.3). */
export function manifestPath(path) {
  return path.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * The payload manifest the digest is computed over: one `<hex>  <path>` line
 * per file, LF-terminated, sorted by the UTF-8 bytes of the path.
 * @param {Map<string, string>} fileDigests  NFC path -> lowercase hex SHA-256
 */
export function manifestText(fileDigests) {
  return [...fileDigests.entries()]
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
    .map(([path, hex]) => `${hex}  ${manifestPath(path)}\n`)
    .join('');
}

/**
 * Computes moca-digest-v2.
 *
 * @param {import('./source.js').PackageSource} source
 * @param {Map<string, string>} files  NFC path -> stored path, from packageFiles()
 * @param {(path: string) => Buffer} [read]  defaults to source.read
 * @returns {{ digest: string, fileDigests: Map<string, string>, manifest: string }}
 *   fileDigests: NFC path -> hex, moca.json included; manifest: the BagIt-style text
 */
export function computeDigest(source, files, read = (p) => source.read(p)) {
  const fileDigests = new Map();
  for (const [nfc, stored] of files) {
    if (isAttestationPath(nfc)) continue;
    fileDigests.set(nfc, sha256Hex(read(stored)));
  }
  const manifest = manifestText(fileDigests);
  return { digest: `sha256:${sha256Hex(Buffer.from(manifest, 'utf8'))}`, fileDigests, manifest };
}
