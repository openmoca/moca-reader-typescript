// Content traversal: content/ is an Open Knowledge Format (OKF) v0.2 bundle.
// See spec/moca-package-spec.md §5 and spec/moca-reader-contract.md §5.
import { parseInstant } from './dates.js';
import { posix } from 'node:path';
import { splitFrontmatter } from './frontmatter.js';
import { validateAgainst } from './schemas.js';
import { sourceKind, checkSelector, normalisedText } from './evidence-text.js';

export { selectorMatches } from './evidence-text.js';

export const CONTENT_DIR = 'content';
const RESERVED = new Set(['index.md', 'log.md']);
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// A Windows drive prefix (C:\x, C:/x) is a path, not a URL scheme.
const DRIVE = /^[A-Za-z]:[\\/]/;
const LINK = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const PATH_REF = /^(\.{1,2}\/|\/)/;
const EVIDENCE_DIRS = ['sources/', 'media/'];

/**
 * @typedef {object} Representation
 * @property {string|null} locale  null = the default language
 * @property {string} file         package-relative path
 * @property {object} frontmatter
 * @property {string} body
 * @property {number} bodyOffset   UTF-8 byte offset of the body in the file
 * @property {string} sha256       hex digest of the file bytes
 * @property {EvidenceCheck[]} evidenceChecks  one per moca.evidence entry, in order
 *
 * @typedef {object} EvidenceCheck
 * @property {boolean} local       the source is a file under sources/ or media/ in the package
 * @property {boolean} [matched]  set only when the selector was checked against that file
 *
 * @typedef {object} ContentNode
 * @property {string} path  node path relative to content/ (the default-language file name)
 * @property {Representation[]} representations  default language first
 */

/**
 * @param {object} p
 * @param {object} p.manifest
 * @param {Map<string, string>} p.files      NFC path -> stored path
 * @param {Map<string, Buffer>} p.bytes      NFC path -> bytes
 * @param {Map<string, string>} p.fileDigests NFC path -> hex
 * @param {import('./diagnostics.js').Diagnostics} p.diagnostics
 * @param {typeof import('./source.js').DEFAULT_LIMITS} p.limits
 * @returns {ContentNode[]}
 */
/** Contract §7: an evidence source is UTF-8 text, and a leading byte order mark is not part of it. */
function sourceString(buf) {
  const text = buf.toString('utf8');
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

export function readContent({ manifest, files, bytes, fileDigests, diagnostics, limits }) {
  const sourceText = new Map();
  const locales = new Map((manifest.locales ?? []).map((l) => [l.toLowerCase(), l]));
  const byKey = new Map();
  const mdFiles = [...files.keys()].filter((p) => p.startsWith(`${CONTENT_DIR}/`) && p.toLowerCase().endsWith('.md')).sort();

  for (const file of mdFiles) {
    const rel = file.slice(CONTENT_DIR.length + 1);
    const base = posix.basename(rel);
    const text = bytes.get(file).toString('utf8');

    if (RESERVED.has(base.toLowerCase())) {
      checkReserved(file, rel, base.toLowerCase(), text, diagnostics, limits);
      continue;
    }

    const { key, locale } = localeOf(rel, locales);
    const split = splitFrontmatter(text, { maxBytes: limits.maxFrontmatterBytes });
    if (!split.present) {
      diagnostics.add('C001_FRONTMATTER_MISSING', 'concept documents must open with a YAML frontmatter block', { file });
      continue;
    }
    if (split.error) {
      diagnostics.add('C002_FRONTMATTER_INVALID', split.error, { file, line: split.line });
      continue;
    }
    const fm = split.data;
    if (typeof fm.type !== 'string' || fm.type.trim() === '') {
      diagnostics.add('C003_TYPE_MISSING', 'frontmatter needs a non-empty "type"', { file });
      continue;
    }
    for (const err of validateAgainst('node', fm)) {
      diagnostics.add('C005_FIELD_INVALID', err, { file });
    }
    checkEvidence(file, fm, diagnostics);
    checkWindow(file, fm, diagnostics);
    checkPaths(file, fm, split.body, files, diagnostics);
    const evidenceChecks = verifyEvidence(file, fm, files, bytes, diagnostics, limits, sourceText);

    const rep = { locale, file, frontmatter: fm, body: split.body, bodyOffset: split.bodyOffset, sha256: fileDigests.get(file), evidenceChecks };
    if (!byKey.has(key)) byKey.set(key, { path: key, representations: [] });
    byKey.get(key).representations.push(rep);
  }

  const nodes = [];
  for (const node of [...byKey.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    node.representations.sort((a, b) => (a.locale === null ? -1 : b.locale === null ? 1 : a.locale < b.locale ? -1 : 1));
    if (node.representations[0].locale !== null) {
      diagnostics.add('C009_LOCALE_ORPHAN', `locale variant has no default-language file ${CONTENT_DIR}/${node.path}`, { file: node.representations[0].file });
    }
    nodes.push(node);
  }
  return nodes;
}

function localeOf(rel, locales) {
  const m = rel.match(/^(.*)\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)\.md$/i);
  if (m && locales.has(m[2].toLowerCase())) return { key: `${m[1]}.md`, locale: locales.get(m[2].toLowerCase()) };
  return { key: rel, locale: null };
}

function checkReserved(file, rel, base, text, diagnostics, limits) {
  // Contract §3: the frontmatter size limit applies to reserved files too.
  const split = splitFrontmatter(text, { maxBytes: limits.maxFrontmatterBytes });
  if (base === 'index.md') {
    if (!split.present) return;
    const keys = split.data && typeof split.data === 'object' ? Object.keys(split.data) : [];
    const rootIndex = rel.toLowerCase() === 'index.md';
    if (split.error || !rootIndex || keys.some((k) => k !== 'okf_version')) {
      diagnostics.add('C004_RESERVED_FILE_INVALID', rootIndex
        ? 'the bundle-root index.md may carry only an okf_version frontmatter key'
        : 'index.md files carry no frontmatter', { file });
    }
    return;
  }
  if (split.present) {
    diagnostics.add('C004_RESERVED_FILE_INVALID', 'log.md carries no frontmatter', { file });
  }
  // Headings inside fenced code blocks are not headings.
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const h = line.match(/^##\s+(.*)$/);
    if (h && !/^\d{4}-\d{2}-\d{2}/.test(h[1])) {
      diagnostics.add('C004_RESERVED_FILE_INVALID', `log.md date headings must start with an ISO 8601 date: "${h[1]}"`, { file, line: i + 1 });
    }
  });
}

function checkEvidence(file, fm, diagnostics) {
  const evidence = fm.moca?.evidence;
  if (!Array.isArray(evidence)) return;
  const ids = new Set((Array.isArray(fm.sources) ? fm.sources : []).map((s) => s?.id).filter(Boolean));
  for (const e of evidence) {
    if (e && typeof e.source === 'string' && !ids.has(e.source)) {
      diagnostics.add('C006_EVIDENCE_SOURCE_UNKNOWN', `evidence names source "${e.source}", which sources[] does not declare with that id`, { file });
    }
  }
}

/**
 * Checks each moca.evidence selector against the cited file when that file is
 * inside the package and checkable (text, Markdown, HTML or WebVTT), after the
 * normalisation in evidence-text.js (Reader contract §7).
 * @returns {EvidenceCheck[]}
 */
function verifyEvidence(file, fm, files, bytes, diagnostics, limits, sourceText) {
  const evidence = fm.moca?.evidence;
  if (!Array.isArray(evidence)) return [];
  const sources = new Map((Array.isArray(fm.sources) ? fm.sources : []).filter((s) => s?.id).map((s) => [s.id, s]));
  return evidence.map((e, i) => {
    const resource = sources.get(e?.source)?.resource;
    if (typeof resource !== 'string' || !PATH_REF.test(resource)) return { local: false };
    const { path, escapes } = resolveReference(file, resource);
    if (escapes || !path || !files.has(path) || !EVIDENCE_DIRS.some((d) => path.startsWith(d))) return { local: false };
    const kind = sourceKind(path);
    if (!kind || !e.selector || typeof e.selector !== 'object') return { local: true };
    if (i >= limits.maxEvidencePerNode || bytes.get(path).length > limits.maxSourceBytesChecked) return { local: true };
    // Contract §3: a per-package budget of checks and of source bytes normalised.
    const budget = sourceText.budget ?? (sourceText.budget = { checks: 0, bytes: 0, prepared: new Map() });
    if (budget.checks >= limits.maxEvidenceChecksPerPackage) return { local: true };
    const cacheKey = `${path}\u0000${kind}`;
    let prepared = budget.prepared.get(cacheKey);
    // Every check counts the source bytes it may scan against the package budget.
    if (budget.bytes + bytes.get(path).length > limits.maxEvidenceBytesPerPackage) return { local: true };
    budget.bytes += bytes.get(path).length;
    budget.checks += 1;
    if (!prepared && e.selector.type !== 'FragmentSelector') {
      const text = normalisedText(sourceString(bytes.get(path)), kind);
      prepared = { text, codePoints: [...text].length };
      budget.prepared.set(cacheKey, prepared);
    }
    if (!sourceText.has(path)) sourceText.set(path, sourceString(bytes.get(path)));
    const matched = checkSelector(e.selector, sourceText.get(path), kind, prepared);
    if (matched === false) {
      diagnostics.add('C011_EVIDENCE_SELECTOR_UNMATCHED', `evidence ${e.selector.type} for source "${e.source}" does not match ${path}`, { file });
    }
    return matched === undefined ? { local: true } : { local: true, matched };
  });
}

function checkWindow(file, fm, diagnostics) {
  const from = parseInstant(fm.moca?.valid_from);
  const until = parseInstant(fm.moca?.valid_until);
  if (!Number.isNaN(from) && !Number.isNaN(until) && until <= from) {
    diagnostics.add('C010_VALIDITY_WINDOW_INVALID', 'moca.valid_until must be later than moca.valid_from', { file });
  }
}

/**
 * Resolves a package-relative reference from a node. An absolute path or a
 * drive prefix is unsafe, as is one that escapes the package root (C008); so is
 * a malformed percent-encoding, which never throws.
 * @returns {{ path: string|null, escapes: boolean, reason?: string }}
 */
export function resolveReference(fromFile, ref) {
  let clean;
  try {
    clean = decodeURIComponent(ref.replace(/^<|>$/g, '').split('#')[0].split('?')[0]);
  } catch {
    return { path: null, escapes: true, reason: 'has a malformed percent-encoding' };
  }
  if (clean === '') return { path: null, escapes: false };
  if (clean.startsWith('/') || clean.startsWith('\\') || DRIVE.test(clean)) {
    return { path: null, escapes: true, reason: 'is absolute' };
  }
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), clean));
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) {
    return { path: null, escapes: true, reason: 'escapes the package root' };
  }
  return { path: joined.normalize('NFC'), escapes: false };
}

function checkPaths(file, fm, body, files, diagnostics) {
  for (const s of Array.isArray(fm.sources) ? fm.sources : []) {
    const r = typeof s?.resource === 'string' ? s.resource : '';
    if (!/^(\.{1,2}\/|\/)/.test(r)) continue; // URLs and scope descriptors are not paths
    const { path, escapes, reason } = resolveReference(file, r);
    if (escapes) diagnostics.add('C008_UNSAFE_PATH', `source resource "${r}" ${reason}`, { file });
    else if (path && !files.has(path)) diagnostics.add('C007_LINK_UNRESOLVED', `source resource "${r}" does not resolve to a package file`, { file });
  }

  let fence = false;
  body.split(/\r?\n/).forEach((line) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(LINK)) {
      const target = m[1].replace(/^<|>$/g, '');
      if ((SCHEME.test(target) && !DRIVE.test(target)) || target.startsWith('#')) continue;
      const resolved = resolveReference(file, target);
      if (resolved.escapes) diagnostics.add('C008_UNSAFE_PATH', `link "${target}" ${resolved.reason}`, { file });
      else if (resolved.path && !files.has(resolved.path)) diagnostics.add('C007_LINK_UNRESOLVED', `link "${target}" does not resolve`, { file });
    }
  });
}
