// Encrypted packages (moca-spec spec/moca-encrypted-package.md): recognising an envelope and opening it in the
// order of §5.2. The age decryption itself is not here: the host passes a decryptor (`ageDecryptor` from
// `@openmoca/moca-core/age`) with its key provider. Without one, this Reader does not implement the optional
// feature `encryption`, and an envelope is reported with E001 after its entries are checked.
import { duplicateKey } from './json-strict.js';
import { validateAgainst } from './schemas.js';
import { DEFAULT_LIMITS, openSource, TargetError } from './source.js';
import { Diagnostics } from './diagnostics.js';
import { bindSidecar } from './sidecar.js';
import { imageProblem } from './manifest.js';

export const MARKER = 'moca-enc.json';
const PACKAGE_AGE = 'package.age';
const INDEX_AGE = 'index.age';
const STRUCTURE_COPY = 'outline/structure.ttl';
const ALLOWED = new Set([MARKER, PACKAGE_AGE, STRUCTURE_COPY, INDEX_AGE]);
/** Encrypted packages §3: the opt-in cover copy, by name, and the type its extension gives. */
const COVER_COPIES = new Map([['outline/cover.png', 'image/png'], ['outline/cover.jpg', 'image/jpeg'], ['outline/cover.webp', 'image/webp']]);
const STORED = 0;

/** Whether an archive source is an envelope: moca-enc.json at its root (encrypted packages §2). */
export function isEnvelope(source, files) {
  return source.kind === 'archive' && files.has(MARKER);
}

/** Parses moca-enc.json like moca.json: strict UTF-8, no repeated member names, then its schema. */
function parseMarker(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^﻿/, '');
    const marker = JSON.parse(text);
    const repeated = duplicateKey(text);
    if (repeated !== null) return { error: `member "${repeated}" appears more than once` };
    const errors = validateAgainst('mocaEnc', marker);
    return errors.length > 0 ? { error: errors.join('; ') } : { marker };
  } catch (err) {
    return { error: `not valid UTF-8 JSON: ${err.message}` };
  }
}

/** JSON values equal as values: objects by members in any order, arrays in order (encrypted packages §3). */
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

/**
 * The outline check (encrypted packages §3), run on the inner package once its manifest is parsed.
 * @returns {string|null} why it fails, or null when it passes
 */
export function outlineMismatch(check, manifest, innerBytes, limits = DEFAULT_LIMITS) {
  for (const [key, value] of Object.entries(check.outline ?? {})) {
    if (!manifest || !Object.hasOwn(manifest, key)) return `the outline has "${key}", and the manifest does not`;
    if (!jsonEqual(value, manifest[key])) return `the outline's "${key}" differs from the manifest's`;
  }
  if (check.structure) {
    const inner = innerBytes.get('structure.ttl');
    if (!inner) return 'the envelope has a structure copy, and the package has no structure.ttl';
    if (!Buffer.from(check.structure).equals(Buffer.from(inner))) return 'the structure copy differs from structure.ttl';
  }
  if (check.cover) {
    // The first images entry with role cover, which must pass its checks (package spec §4.6).
    const cover = (Array.isArray(manifest?.images) ? manifest.images : []).find((i) => i && typeof i === 'object' && i.role === 'cover');
    if (!cover || typeof cover.src !== 'string' || typeof cover.type !== 'string') return 'the envelope has a cover copy, and the manifest has no cover image';
    const problem = imageProblem(cover, innerBytes, limits.maxImageBytes);
    if (problem) return `the envelope has a cover copy, and the manifest's cover fails its checks: ${problem}`;
    if (COVER_COPIES.get(check.cover.name) !== cover.type) return `the cover copy ${check.cover.name} does not match the cover's type ${cover.type}`;
    if (!Buffer.from(check.cover.bytes).equals(Buffer.from(innerBytes.get(cover.src.normalize('NFC'))))) return `the cover copy differs from ${cover.src}`;
  }
  return null;
}

const AGE_CODES = {
  header: 'E006_AGE_HEADER_INVALID',
  noKey: 'E001_ENCRYPTED_NO_KEY',
  noMatch: 'E002_DECRYPTION_FAILED',
  mac: 'E002_DECRYPTION_FAILED',
  payload: 'E003_PAYLOAD_CORRUPT',
  limit: 'T003_ARCHIVE_REJECTED',
};

/** Maps a decryptor failure to its code; anything else is a programmer error and is rethrown. */
function codeOf(err) {
  const code = err && typeof err === 'object' ? AGE_CODES[err.kind] : undefined;
  if (!code) throw err;
  return code;
}

/**
 * Steps 3–6 of encrypted packages §5.2 for one encrypted entry: the age header, the key provider, the MAC and the
 * payload. Returns the plaintext, or the code that ended it.
 * @returns {Promise<{ plain?: Uint8Array, code?: string, message?: string }>}
 */
export async function openAgeEntry(bytes, file, outline, options) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const decryptor = options.decryptor;
  if (!decryptor) return { code: 'E001_ENCRYPTED_NO_KEY', message: 'this Reader was not given a decryptor, so it does not open envelopes' };
  let header;
  try {
    header = decryptor.parseHeader(bytes, { maxScryptWorkFactor: limits.maxScryptWorkFactor });
  } catch (err) {
    return { code: codeOf(err), message: `${file}.age: ${err.message}` };
  }
  if (typeof options.keyProvider !== 'function') return { code: 'E001_ENCRYPTED_NO_KEY', message: 'the host supplied no key provider' };
  let key;
  try {
    // Encrypted packages §5.1: stanzas are data; the outline is unverified.
    key = await options.keyProvider({
      stanzas: header.stanzas.map(({ type, args, body }) => ({ type, args: [...args], body: new Uint8Array(body) })),
      outline: outline === undefined ? undefined : structuredClone(outline),
      file,
    });
  } catch (err) {
    return { code: 'E001_ENCRYPTED_NO_KEY', message: `the key provider failed: ${err?.message ?? err}` };
  }
  if (!key || typeof key !== 'object') return { code: 'E001_ENCRYPTED_NO_KEY', message: 'the key provider returned no key' };
  try {
    return { plain: decryptor.decrypt(bytes, header, key, { maxBytes: limits.maxBytes }) };
  } catch (err) {
    return { code: codeOf(err), message: `${file}.age: ${err.message}` };
  }
}

/**
 * Opens an envelope (encrypted packages §5.2). `readInner(bytes, check)` reads the decrypted archive under the
 * Reader contract and runs the outline check right after its manifest is parsed.
 * @param {object} result  the empty package result to fill
 */
export async function readEnvelope({ source, files, entriesOk, diagnostics, options, result, readInner, finish }) {
  // Step 1: the outer archive's rules (T003, P001–P003) were applied by openSource and packageFiles.
  if (!entriesOk) return finish(result, diagnostics);
  result.envelope = { opened: false };
  const fail = (code, message, file) => {
    diagnostics.add(code, message, file ? { file } : undefined);
    return finish(result, diagnostics);
  };

  // Step 2: the entry set and the marker.
  if (files.has('moca.json')) return fail('E005_ENVELOPE_INVALID', 'a Zip with both moca.json and moca-enc.json at its root is neither a package nor an envelope', MARKER);
  if (source.hiddenEntries?.length > 0) return fail('E005_ENVELOPE_INVALID', `an envelope may not have a hidden entry: "${source.hiddenEntries[0]}"`);
  for (const path of files.keys()) {
    if (!ALLOWED.has(path) && !COVER_COPIES.has(path)) return fail('E005_ENVELOPE_INVALID', `an envelope may not have the entry "${path}"`, path);
  }
  if (!files.has(PACKAGE_AGE)) return fail('E005_ENVELOPE_INVALID', 'the envelope has no package.age');
  const covers = [...COVER_COPIES.keys()].filter((name) => files.has(name));
  if (covers.length > 1) return fail('E005_ENVELOPE_INVALID', `an envelope has at most one cover copy, and this one has ${covers.join(', ')}`, covers[1]);
  const entries = new Map(source.list().map((e) => [e.path.normalize('NFC'), e]));
  for (const name of [PACKAGE_AGE, INDEX_AGE]) {
    if (entries.has(name) && entries.get(name).method !== STORED) return fail('E005_ENVELOPE_INVALID', `${name} must be stored, not compressed`, name);
  }
  let parsed;
  try {
    parsed = parseMarker(source.read(files.get(MARKER)));
  } catch (err) {
    return fail('P002_UNREADABLE_ENTRY', `"${MARKER}" could not be read: ${err.message}`, MARKER);
  }
  if (parsed.error) return fail('E005_ENVELOPE_INVALID', `moca-enc.json is invalid: ${parsed.error}`, MARKER);
  const { format, outline } = parsed.marker;
  result.envelope = { format, opened: false, ...(outline !== undefined ? { outline } : {}) };

  // Steps 3–6.
  let packageBytes;
  let structureCopy;
  let cover;
  try {
    packageBytes = source.read(files.get(PACKAGE_AGE));
    structureCopy = files.has(STRUCTURE_COPY) ? source.read(files.get(STRUCTURE_COPY)) : undefined;
    if (covers.length === 1) cover = { name: covers[0], bytes: source.read(files.get(covers[0])) };
  } catch (err) {
    return fail('P002_UNREADABLE_ENTRY', `an envelope entry could not be read: ${err.message}`);
  }
  const maxImageBytes = { ...DEFAULT_LIMITS, ...options.limits }.maxImageBytes;
  if (cover && cover.bytes.length > maxImageBytes) return fail('E005_ENVELOPE_INVALID', `${cover.name} is ${cover.bytes.length} bytes, over the limit of ${maxImageBytes}`, cover.name);
  const opened = await openAgeEntry(new Uint8Array(packageBytes), 'package', outline, options);
  if (opened.code) return fail(opened.code, opened.message, PACKAGE_AGE);

  // Steps 7–10: the inner archive, with the outline check (step 8) right after its manifest is read.
  const inner = await readInner(opened.plain, { outline, structure: structureCopy, cover });
  const innerFailed = inner.diagnostics.some((d) => d.severity === 'error' && /^(T|P|E004)/.test(d.code)) || inner.manifest === null;
  if (innerFailed) {
    // Encrypted packages §5.3: nothing from the inner archive is exposed; its diagnostics are reported.
    for (const d of inner.diagnostics) diagnostics.items.push(d);
    return finish(result, diagnostics);
  }
  inner.diagnostics.unshift(...diagnostics.items);
  inner.envelope = { format, opened: true };
  return inner;
}

/**
 * Binds an envelope's `index.age` to the package result of the same envelope (encrypted packages §6): opened
 * through the same key provider (`file: "index"`) and steps 3–6, then bound as any sidecar. A failure makes the
 * sidecar unusable and is reported here with its code; it never changes the package's validity.
 * @param {string|Uint8Array} target  the envelope
 * @param {object} pkg  the result of reading that envelope
 * @param {object} options  the read options, with `keyProvider` and `decryptor`
 */
export async function bindEnvelopeSidecar(target, pkg, options = {}) {
  const diagnostics = new Diagnostics(options);
  const out = { usable: false, index: null, chunks: [], diagnostics: diagnostics.items };
  if (!pkg?.envelope?.opened) {
    diagnostics.add('S001_SIDECAR_INVALID', 'index.age binds only to an opened envelope');
    return out;
  }
  let source;
  try {
    source = openSource(target, options.limits);
  } catch (err) {
    if (err instanceof TargetError) {
      diagnostics.add('S001_SIDECAR_INVALID', err.message);
      return out;
    }
    throw err;
  }
  const entry = source.list().find((e) => e.path === INDEX_AGE);
  if (!entry) {
    diagnostics.add('S001_SIDECAR_INVALID', 'the envelope has no index.age');
    return out;
  }
  if (entry.method !== STORED) {
    diagnostics.add('E005_ENVELOPE_INVALID', 'index.age must be stored, not compressed', { file: INDEX_AGE });
    return out;
  }
  const opened = await openAgeEntry(new Uint8Array(source.read(INDEX_AGE)), 'index', pkg.envelope.outline, options);
  if (opened.code) {
    diagnostics.add(opened.code, opened.message, { file: INDEX_AGE });
    return out;
  }
  const bound = bindSidecar(opened.plain, pkg, options);
  diagnostics.items.push(...bound.diagnostics);
  return { ...bound, diagnostics: diagnostics.items };
}
