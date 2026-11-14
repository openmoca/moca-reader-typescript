// Package sources: a uniform view of a package, whether it is a directory, a
// .moca Zip archive, or a host-supplied object. Every source lists its
// entries and returns the bytes of a listed file. See
// spec/moca-reader-contract.md §3.
//
// A source never follows a symbolic link and never hides one: symlinks and
// other non-regular files are listed with kind "symlink"/"other" so the
// digest and the reader can refuse them (spec/moca-package-spec.md §6).
// Entries whose name begins with "." are not part of a package and are
// skipped entirely, including their subtrees.
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import AdmZip from 'adm-zip';

export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxBytes: 512 * 1024 * 1024,
  maxFrontmatterBytes: 64 * 1024,
  maxStructureBytes: 4 * 1024 * 1024,
  maxTriples: 100_000,
  maxEvidencePerNode: 256,
  maxSourceBytesChecked: 8 * 1024 * 1024,
  // Contract §3: evidence work for the whole package is bounded too.
  maxEvidenceChecksPerPackage: 10_000,
  maxEvidenceBytesPerPackage: 256 * 1024 * 1024,
  // Contract §3 and package spec §7.1: composition is bounded in depth and in members resolved per read.
  maxMemberDepth: 8,
  maxMembers: 256,
  // Encrypted packages §4: the scrypt work factor (log2 N) a Reader runs, at most.
  maxScryptWorkFactor: 20,
  // Package spec §4.6: the bytes of one manifest image (and of an envelope's cover copy).
  maxImageBytes: 1024 * 1024,
});

/**
 * @typedef {object} SourceEntry
 * @property {string} path  package-relative POSIX path, as stored
 * @property {'file'|'symlink'|'other'|'unreadable'} kind
 * @property {number} [size]
 *
 * @typedef {object} PackageSource
 * @property {string} kind  'directory' | 'archive' | 'host'
 * @property {string} [location]
 * @property {() => SourceEntry[]} list
 * @property {(path: string) => Buffer} read
 */

export class TargetError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Names that are never part of a package. */
export function isHiddenSegment(name) {
  return name.startsWith('.');
}

/**
 * @param {string} rootDir
 * @returns {PackageSource}
 */
export function directorySource(rootDir, limits = {}) {
  const { maxEntries, maxBytes } = { ...DEFAULT_LIMITS, ...limits };
  let cache;
  let read = 0;
  return {
    kind: 'directory',
    location: rootDir,
    list() {
      if (cache) return cache;
      const entries = walkDirectory(rootDir);
      // Contract §3: the entry and byte limits apply to every source, directories included.
      if (entries.length > maxEntries) throw new TargetError('T003_ARCHIVE_REJECTED', `directory has ${entries.length} entries, over the ${maxEntries} limit`);
      const total = entries.reduce((n, e) => n + (e.size ?? 0), 0);
      if (total > maxBytes) throw new TargetError('T003_ARCHIVE_REJECTED', `directory exceeds the ${maxBytes}-byte limit`);
      cache = entries;
      return cache;
    },
    read(path) {
      const abs = join(rootDir, ...path.split('/'));
      // Never follow a link swapped in after listing.
      if (!lstatSync(abs).isFile()) throw new Error(`${path} is no longer a regular file`);
      const bytes = readFileSync(abs);
      read += bytes.length;
      if (read > maxBytes) throw new TargetError('T003_ARCHIVE_REJECTED', `directory exceeds the ${maxBytes}-byte limit`);
      return bytes;
    },
  };
}

function walkDirectory(rootDir) {
  /** @type {SourceEntry[]} */
  const out = [];
  const visit = (absDir, relDir) => {
    let names;
    try {
      names = readdirSync(absDir);
    } catch {
      out.push({ path: relDir || '.', kind: 'unreadable' });
      return;
    }
    for (const name of names.sort()) {
      if (isHiddenSegment(name)) continue;
      const abs = join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        out.push({ path: rel, kind: 'unreadable' });
        continue;
      }
      if (st.isSymbolicLink()) out.push({ path: rel, kind: 'symlink' });
      else if (st.isDirectory()) visit(abs, rel);
      else if (st.isFile()) out.push({ path: rel, kind: 'file', size: st.size });
      else out.push({ path: rel, kind: 'other' });
    }
  };
  visit(rootDir, '');
  return out;
}

/**
 * Opens a .moca/.zip archive in memory, without extracting it.
 *
 * @param {string|Buffer} archive  path or bytes
 * @param {{ maxEntries?: number, maxBytes?: number }} [limits]
 * @returns {PackageSource}
 */
export function archiveSource(archive, limits = {}) {
  const { maxEntries, maxBytes } = { ...DEFAULT_LIMITS, ...limits };
  let zip;
  try {
    zip = new AdmZip(archive);
  } catch (err) {
    throw new TargetError('T003_ARCHIVE_REJECTED', `archive could not be opened: ${err.message}`);
  }
  let entries;
  try {
    entries = zip.getEntries();
  } catch (err) {
    // Contract §3: two entries with one name collide (P003); anything else rejects the archive.
    if (/Duplicate entry/i.test(err.message)) throw new TargetError('P003_PATH_COLLISION', `archive has two entries with one name: ${err.message}`);
    throw new TargetError('T003_ARCHIVE_REJECTED', `archive could not be read: ${err.message}`);
  }
  if (entries.length > maxEntries) {
    throw new TargetError('T003_ARCHIVE_REJECTED', `archive has ${entries.length} entries, over the ${maxEntries} limit`);
  }
  let total = 0;
  /** @type {SourceEntry[]} */
  const listed = [];
  const byPath = new Map();
  // Encrypted packages §2: an envelope must have no hidden entry, so the names skipped here are kept.
  const hiddenEntries = [];
  for (const entry of entries) {
    const name = entry.entryName;
    // Contract §3: entry names are UTF-8. A name with bytes outside ASCII and
    // without the UTF-8 flag (general purpose bit 11) is rejected, not guessed.
    if (!entry.header.flags_efs && entry.rawEntryName.some((b) => b >= 0x80)) {
      throw new TargetError('T003_ARCHIVE_REJECTED', 'archive entry name is not marked as UTF-8');
    }
    assertSafeArchivePath(name);
    total += entry.header.size;
    if (total > maxBytes) {
      throw new TargetError('T003_ARCHIVE_REJECTED', `archive expands beyond the ${maxBytes}-byte limit`);
    }
    if (entry.isDirectory) continue;
    const path = name.replace(/\/+$/, '');
    if (path.split('/').some(isHiddenSegment)) {
      hiddenEntries.push(path);
      continue;
    }
    const mode = (entry.header.attr >>> 16) & 0o170000;
    let kind = 'file';
    if (mode === 0o120000) kind = 'symlink';
    else if (mode !== 0 && mode !== 0o100000) kind = 'other';
    listed.push({ path, kind, size: entry.header.size, method: entry.header.method });
    byPath.set(path, entry);
  }
  listed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    kind: 'archive',
    location: typeof archive === 'string' ? archive : undefined,
    list: () => listed,
    hiddenEntries,
    read(path) {
      const entry = byPath.get(path);
      if (!entry) throw new Error(`no such entry: ${path}`);
      return inflateEntry(entry);
    },
  };
}

// Slack for the inflate cap. workerd (Cloudflare Workers) refuses a synchronous inflate whose cap is the exact
// output size for some sizes ("Memory limit exceeded"), while Node accepts it. The output must still be exactly
// the declared size, so the slack never lets more through: it is only room for the runtime's buffer to grow.
const INFLATE_SLACK = 64 * 1024;
const DEFLATE = 8;

/**
 * An entry's bytes. A deflated entry is inflated here, not by the zip library, so the same code runs in Node and
 * in a Worker. Each entry inflates no further than its declared size (plus slack, then checked exactly) and must
 * match its CRC-32, so an archive whose sizes lie cannot expand past the declared total.
 */
function inflateEntry(entry) {
  const { method, size, crc, flags } = entry.header;
  // Encrypted entries (flag bit 0) and other methods: the zip library refuses or reads them.
  if ((method !== DEFLATE && method !== 0) || flags & 1) return entry.getData();
  // Contract §3: a stored entry is checked as a deflated one is: exactly its declared size, and its CRC-32.
  const data = method === 0 ? entry.getCompressedData() : inflateRawSync(entry.getCompressedData(), { maxOutputLength: size + INFLATE_SLACK });
  if (data.length !== size) throw new Error(`inflates to ${data.length} bytes, not the ${size} its header declares`);
  if (crc32(data) !== crc) throw new Error('fails its CRC-32 check');
  return data;
}

function assertSafeArchivePath(name) {
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new TargetError('T003_ARCHIVE_REJECTED', `archive entry "${name}" is absolute or uses backslashes`);
  }
  if (name.split('/').includes('..')) {
    throw new TargetError('T003_ARCHIVE_REJECTED', `archive entry "${name}" contains a ".." segment`);
  }
  // Contract §3: no NUL, and no empty or "." segments (a trailing "/" marks a directory).
  const segments = name.replace(/\/+$/, '').split('/');
  if (name.includes('\0') || segments.some((s) => s === '' || s === '.')) {
    throw new TargetError('T003_ARCHIVE_REJECTED', `archive entry "${name.replace(/\0/g, '\\0')}" has an empty, "." or NUL segment`);
  }
}

/**
 * Wraps a host-supplied source: `{ list(): string[] | SourceEntry[], read(path): Buffer|Uint8Array }`.
 *
 * @param {{ list: () => Array<string|SourceEntry>, read: (path: string) => Buffer|Uint8Array }} host
 * @param {{ maxEntries?: number, maxBytes?: number }} [limits]
 * @returns {PackageSource}
 */
export function hostSource(host, limits = {}) {
  const { maxEntries, maxBytes } = { ...DEFAULT_LIMITS, ...limits };
  let cache;
  let read = 0;
  return {
    kind: 'host',
    list() {
      if (cache) return cache;
      const raw = host.list().map((e) => (typeof e === 'string' ? { path: e, kind: 'file' } : e));
      if (raw.length > maxEntries) {
        throw new TargetError('T003_ARCHIVE_REJECTED', `source lists ${raw.length} entries, over the ${maxEntries} limit`);
      }
      let total = 0;
      for (const e of raw) {
        assertSafeArchivePath(e.path);
        total += e.size ?? 0;
        if (total > maxBytes) throw new TargetError('T003_ARCHIVE_REJECTED', `source exceeds the ${maxBytes}-byte limit`);
      }
      cache = raw
        .filter((e) => !e.path.split('/').some(isHiddenSegment))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return cache;
    },
    read(path) {
      if (!cache?.some((e) => e.path === path)) throw new Error(`path was not listed: ${path}`);
      const bytes = Buffer.from(host.read(path));
      // Contract §3: a host source need not list sizes, so the byte limit is
      // also enforced on what is actually read.
      read += bytes.length;
      if (read > maxBytes) throw new TargetError('T003_ARCHIVE_REJECTED', `source exceeds the ${maxBytes}-byte limit`);
      return bytes;
    },
  };
}

/** Whether a file starts with a Zip local-file or end-of-central-directory signature. */
function isZipFile(path) {
  const head = Buffer.alloc(4);
  let fd;
  try {
    fd = openSync(path, 'r');
    readSync(fd, head, 0, 4, 0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || head.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
}

/**
 * Resolves a target: a directory path, a .moca/.zip path, or a host source object.
 *
 * @param {string|object} target
 * @param {{ maxEntries?: number, maxBytes?: number }} [limits]
 * @returns {PackageSource}
 */
export function openSource(target, limits) {
  if (target && typeof target === 'object' && typeof target.list === 'function') {
    const alreadyWrapped = ['directory', 'archive', 'host'].includes(target.kind) && typeof target.read === 'function';
    return alreadyWrapped ? target : hostSource(target, limits);
  }
  // Interface §3: archive bytes are a target too.
  if (target instanceof Uint8Array) return archiveSource(Buffer.from(target), limits);
  if (typeof target !== 'string' || !existsSync(target)) {
    throw new TargetError('T001_TARGET_NOT_FOUND', `target does not exist: ${target}`);
  }
  const st = statSync(target);
  if (st.isDirectory()) return directorySource(target, limits);
  if (st.isFile() && /\.(moca|zip)$/i.test(target)) return archiveSource(target, limits);
  // Encrypted packages §2: an envelope (conventionally .moca.enc) is recognised by content, so any file that starts
  // with a Zip signature is read as an archive.
  if (st.isFile() && isZipFile(target)) return archiveSource(target, limits);
  throw new TargetError('T002_MANIFEST_NOT_FOUND', `target exists but is neither a directory nor a .moca/.zip archive: ${target}`);
}
