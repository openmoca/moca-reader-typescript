// Content traversal: content/ is an Open Knowledge Format (OKF) v0.2 bundle.
// See spec/moca-package-spec.md §5 and spec/moca-reader-contract.md §5.
import { inherited } from './inherit.js';
import { parseInstant } from './dates.js';
import { posix } from 'node:path';
import { splitFrontmatter } from './frontmatter.js';
import { validateAgainst } from './schemas.js';
import { checkedCredit } from './manifest.js';
import { sourceKind, checkSelector, normalisedText, isMediaTimeRange, webvtt, forwardFinder } from './evidence-text.js';
import { defaultSync, rangeToReference, syncProblem } from './alternates.js';

export { selectorMatches } from './evidence-text.js';

export const CONTENT_DIR = 'content';
const RESERVED = new Set(['index.md', 'log.md']);
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// A Windows drive prefix (C:\x, C:/x) is a path, not a URL scheme.
const DRIVE = /^[A-Za-z]:[\\/]/;
const SPACE = /\s/;

/**
 * The target of every Markdown link and image in a line, as written (a `<...>` target keeps its brackets). It gives
 * what the first group of
 *   /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
 * captures, in one pass over the line: contract §3 bounds a Reader's work by the size of what it reads, and that
 * expression rescans the line from every `[`.
 */
export function linkTargets(line) {
  const targets = [];
  const open = forwardFinder(line, '[');
  const close = forwardFinder(line, ']');
  const gt = forwardFinder(line, '>');
  // The end of a plain target: the next ")" or white space, or the end of the line.
  const stop = /[)\s]/g;
  let stopAt = -2;
  const targetEnd = (from) => {
    if (stopAt !== -1 && stopAt < from) {
      stop.lastIndex = from;
      stopAt = stop.exec(line) ? stop.lastIndex - 1 : -1;
    }
    return stopAt === -1 ? line.length : stopAt;
  };
  const spaces = new Map();
  const skipSpace = (p) => {
    let e = spaces.get(p);
    if (e === undefined) {
      e = p;
      while (e < line.length && SPACE.test(line[e])) e += 1;
      spaces.set(p, e);
    }
    return e;
  };
  // What follows a target: an optional title in quotes, then ")". The index after the ")", or -1.
  const tail = () => {
    const quote = { '"': forwardFinder(line, '"'), "'": forwardFinder(line, "'") };
    const known = new Map();
    return (p) => {
      if (known.has(p)) return known.get(p);
      const w = skipSpace(p);
      let end = -1;
      if (w > p && (line[w] === '"' || line[w] === "'")) {
        const q = quote[line[w]](w + 1);
        if (q >= 0 && line[skipSpace(q + 1)] === ')') end = skipSpace(q + 1) + 1;
      }
      if (end < 0 && line[w] === ')') end = w + 1;
      known.set(p, end);
      return end;
    };
  };
  // Each kind of target asks from rising positions of its own, so each has its own searches.
  const afterAngle = tail();
  const afterPlain = tail();
  let pos = 0;
  for (;;) {
    const i = open(pos);
    if (i < 0) break;
    const j = close(i + 1);
    if (j < 0) break;
    let end = -1;
    let target;
    if (line[j + 1] === '(') {
      const p = skipSpace(j + 2);
      if (line[p] === '<') {
        const q = gt(p + 1);
        if (q > p + 1) {
          end = afterAngle(q + 1);
          target = line.slice(p, q + 1);
        }
      }
      if (end < 0) {
        const e = targetEnd(p);
        if (e > p) {
          end = afterPlain(e);
          target = line.slice(p, e);
        }
      }
    }
    // Every "[" up to j closes at j, so none of them starts a link either.
    if (end < 0) {
      pos = j + 1;
      continue;
    }
    targets.push(target);
    pos = end;
  }
  return targets;
}
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
 * @property {string} [language]  the default representation's language (the manifest's `language`)
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

export function readContent({ manifest, files, bytes, fileDigests, diagnostics, limits, evidenceBudget = { checks: 0, bytes: 0 } }) {
  const sourceText = new Map();
  // Contract §3: the evidence budget is shared by the whole read; the prepared sources are this package's own.
  sourceText.budget = { prepared: new Map(), shared: evidenceBudget };
  // A manifest that failed its schema is still read: a `locales` of the wrong type declares no locale.
  const declared = Array.isArray(manifest?.locales) ? manifest.locales.filter((l) => typeof l === 'string') : [];
  const locales = new Map(declared.map((l) => [l.toLowerCase(), l]));
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
    // Package spec §5.1: evidence and media name a source by its id, so two sources with one id leave none chosen.
    const repeated = repeatedSourceId(fm);
    if (repeated !== null) {
      diagnostics.add('C002_FRONTMATTER_INVALID', `sources has two entries with the id "${repeated}"; none is chosen`, { file });
      continue;
    }
    if (typeof fm.type !== 'string' || fm.type.trim() === '') {
      diagnostics.add('C003_TYPE_MISSING', 'frontmatter needs a non-empty "type"', { file });
      continue;
    }
    const fieldErrors = validateAgainst('node', fm);
    for (const err of fieldErrors) {
      diagnostics.add('C005_FIELD_INVALID', err, { file });
    }
    // Package spec §4.13: the node's own credits, when they match the node schema; images checked as in §4.6.
    const contributors = Array.isArray(fm.moca?.contributors) && !fieldErrors.some((e) => e.startsWith('/moca/contributors') || e.startsWith('/moca '))
      ? fm.moca.contributors.map((c, i) => checkedCredit(c, `moca.contributors[${i}]`, bytes, limits.maxImageBytes, diagnostics, file))
      : undefined;
    checkEvidence(file, fm, diagnostics);
    checkPaths(file, fm, split.body, files, diagnostics);
    const media = mediaDescriptions(file, fm, files, diagnostics);
    const evidenceChecks = verifyEvidence(file, fm, files, bytes, diagnostics, limits, sourceText, media);

    const rep = { locale, file, frontmatter: fm, body: split.body, bodyOffset: split.bodyOffset, sha256: fileDigests.get(file), evidenceChecks, media, contributors };
    // Package spec §5.4: the default representation's tag in the lookup is the manifest's language.
    if (!byKey.has(key)) byKey.set(key, { path: key, ...(typeof manifest?.language === 'string' && manifest.language !== '' ? { language: manifest.language } : {}), representations: [] });
    byKey.get(key).representations.push(rep);
  }

  const nodes = [];
  for (const node of [...byKey.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    node.representations.sort((a, b) => (a.locale === null ? -1 : b.locale === null ? 1 : a.locale < b.locale ? -1 : 1));
    if (node.representations[0].locale !== null) {
      diagnostics.add('C009_LOCALE_ORPHAN', `locale variant has no default-language file ${CONTENT_DIR}/${node.path}`, { file: node.representations[0].file });
    }
    // Package spec §5.3 and §5.4: a default file's moca.language is its node's language; in a translation it is
    // ignored. A tag that does not parse already has its C005 from the node schema.
    for (const rep of node.representations) {
      const own = rep.frontmatter?.moca && typeof rep.frontmatter.moca === 'object' ? rep.frontmatter.moca.language : undefined;
      if (own === undefined) continue;
      if (rep.locale !== null) {
        diagnostics.add('C005_FIELD_INVALID', `moca.language is ignored in a translation (${rep.file}): its file name says its language`, { file: rep.file });
      } else if (typeof own === 'string' && LANGUAGE_TAG.test(own)) {
        node.language = own;
      }
    }
    // Package spec §5.4: a translation whose tag is its node's own language would be a second file for one tag; it is
    // reported and ignored, so the default file answers for that language.
    if (typeof node.language === 'string') {
      const own = node.language.toLowerCase();
      node.representations = node.representations.filter((rep) => {
        if (rep.locale === null || rep.locale.toLowerCase() !== own) return true;
        diagnostics.add('C012_TRANSLATION_SAME_TAG', `${rep.file} is tagged ${rep.locale}, the language of its node's default file; it is ignored`, { file: rep.file });
        return false;
      });
    }
    // Package spec §5.4: C010 applies to the window each representation ends up with, on its own file.
    for (const rep of node.representations) checkWindow(rep.file, inherited(node, rep, 'valid_from'), inherited(node, rep, 'valid_until'), diagnostics);
    nodes.push(node);
  }
  return nodes;
}

/**
 * Reader interface §4: for each language the nodes come in (each default file's language, and each tag in
 * `locales`), how many nodes have a representation in it, and of how many. Undefined with no node or no language.
 */
export function localeCoverage(manifest, nodes) {
  if (nodes.length === 0) return undefined;
  const counts = new Map();
  const declared = Array.isArray(manifest?.locales) ? manifest.locales.filter((l) => typeof l === 'string') : [];
  for (const tag of declared) counts.set(tag, new Set());
  for (const node of nodes) {
    const tags = new Set(node.representations.map((r) => r.locale ?? node.language).filter((t) => typeof t === 'string'));
    for (const t of tags) {
      if (!counts.has(t)) counts.set(t, new Set());
      counts.get(t).add(node.path);
    }
  }
  if (counts.size === 0) return undefined;
  const out = {};
  for (const [tag, set] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    Object.defineProperty(out, tag, { value: { nodes: set.size, of: nodes.length }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The first source id that two entries of the frontmatter's `sources` share, or null. */
function repeatedSourceId(fm) {
  const seen = new Set();
  for (const s of Array.isArray(fm.sources) ? fm.sources : []) {
    const id = s && typeof s === 'object' ? s.id : undefined;
    if (typeof id !== 'string') continue;
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

function localeOf(rel, locales) {
  const m = rel.match(/^(.*)\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)\.md$/i);
  if (m && locales.has(m[2].toLowerCase())) return { key: `${m[1]}.md`, locale: locales.get(m[2].toLowerCase()) };
  return { key: rel, locale: null };
}

/**
 * A log.md date heading's text, or null when the line is not one: `##`, one or more white-space characters, then the
 * rest of the line, whatever it holds. One pass over the line (contract §3 bounds a Reader's work by the size of what
 * it reads).
 * @param {string} line one line of log.md, without its line break
 * @param {{ steps: number }} [work] counts the characters looked at, for tests
 * @returns {string|null}
 */
export function logHeading(line, work = { steps: 0 }) {
  if (!line.startsWith('##') || !SPACE.test(line.charAt(2))) return null;
  let i = 3;
  while (i < line.length && SPACE.test(line.charAt(i))) { i++; work.steps++; }
  return line.slice(i);
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
    const heading = logHeading(line);
    if (heading !== null && !/^\d{4}-\d{2}-\d{2}/.test(heading)) {
      diagnostics.add('C004_RESERVED_FILE_INVALID', `log.md date headings must start with an ISO 8601 date: "${heading}"`, { file, line: i + 1 });
    }
  });
}

/**
 * The node's sources by id. Package spec §5.1: a source whose id is not a non-empty string has no id (the node schema
 * reports C005), so nothing can name it. A repeated id never reaches here: it is C002.
 * @returns {Map<string, object>}
 */
export function sourcesById(fm) {
  const out = new Map();
  for (const s of Array.isArray(fm?.sources) ? fm.sources : []) {
    if (s && typeof s === 'object' && typeof s.id === 'string' && s.id !== '' && !out.has(s.id)) out.set(s.id, s);
  }
  return out;
}

function checkEvidence(file, fm, diagnostics) {
  const evidence = fm.moca?.evidence;
  if (!Array.isArray(evidence)) return;
  const ids = new Set(sourcesById(fm).keys());
  for (const e of evidence) {
    if (e && typeof e.source === 'string' && !ids.has(e.source)) {
      diagnostics.add('C006_EVIDENCE_SOURCE_UNKNOWN', `evidence names source "${e.source}", which sources[] does not declare with that id`, { file });
    }
  }
}

/** Package spec §5.7: the keys of a media description and the form of each. */
const MEDIA_KEYS = new Set(['source', 'type', 'duration', 'digest', 'transcript', 'alternateOf', 'sync', 'captions']);
// Package spec §5.7, caption tracks: HTML's track kinds, and the BCP 47 shape the manifest's tags have.
const CAPTION_KINDS = new Set(['subtitles', 'captions', 'descriptions', 'chapters']);
const CAPTION_KEYS = new Set(['source', 'language', 'kind']);
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(?:[ \t]*;[^\n\r]*)?$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function wellFormedMedia(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  if (Object.keys(m).some((k) => !MEDIA_KEYS.has(k))) return false;
  if (typeof m.source !== 'string' || m.source === '' || typeof m.type !== 'string' || !MEDIA_TYPE.test(m.type)) return false;
  if (m.duration !== undefined && !(typeof m.duration === 'number' && Number.isFinite(m.duration) && m.duration >= 0)) return false;
  if (m.digest !== undefined && !(typeof m.digest === 'string' && SHA256.test(m.digest))) return false;
  if (m.transcript !== undefined && !(typeof m.transcript === 'string' && m.transcript !== '')) return false;
  if (m.alternateOf !== undefined && !(typeof m.alternateOf === 'string' && m.alternateOf !== '')) return false;
  // Package spec §5.7: a bad caption entry is dropped on its own; only a captions that is not a list fails the description.
  if (m.captions !== undefined && !Array.isArray(m.captions)) return false;
  return m.sync === undefined || (Array.isArray(m.sync) && m.sync.length > 0 && m.sync.every(wellFormedSyncEntry));
}

function wellFormedSyncEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (Object.keys(e).some((k) => k !== 'at' && k !== 'offset') || !('offset' in e)) return false;
  if (!(typeof e.at === 'number' && Number.isFinite(e.at) && e.at >= 0)) return false;
  return e.offset === null || (typeof e.offset === 'number' && Number.isFinite(e.offset));
}

/** The package path of a source's resource when it is a WebVTT file under sources/ or media/, or null. */
function localWebVtt(file, resource, files) {
  const path = localEvidencePath(file, resource, files);
  return path && sourceKind(path) === 'webvtt' ? path : null;
}

/** The package path of a source's resource when it is a file under sources/ or media/, or null. */
function localEvidencePath(file, resource, files) {
  if (typeof resource !== 'string' || !PATH_REF.test(resource)) return null;
  const { path, escapes } = resolveReference(file, resource);
  if (escapes || !path || !files.has(path) || !EVIDENCE_DIRS.some((d) => path.startsWith(d))) return null;
  return path;
}

/**
 * Package spec §5.7: the node's valid media descriptions, in order, each with the source's resource as written and,
 * internally, the package path of its transcript. A malformed description (already reported by the node schema as
 * C005) is ignored; so is one naming an unknown source (C006), or a source already described (C005). A transcript
 * that is not a WebVTT file under sources/ or media/ is dropped (C005).
 */
function mediaDescriptions(file, fm, files, diagnostics) {
  const list = fm.moca?.media;
  if (!Array.isArray(list)) return [];
  const sources = sourcesById(fm);
  const described = new Set();
  const out = [];
  const raw = new Map();
  for (const m of list) {
    if (!wellFormedMedia(m)) continue;
    const source = sources.get(m.source);
    if (!source) {
      diagnostics.add('C006_EVIDENCE_SOURCE_UNKNOWN', `media names source "${m.source}", which sources[] does not declare with that id`, { file });
      continue;
    }
    if (typeof source.resource !== 'string') {
      diagnostics.add('C005_FIELD_INVALID', `media describes source "${m.source}", which has no resource`, { file });
      continue;
    }
    if (described.has(m.source)) {
      diagnostics.add('C005_FIELD_INVALID', `media describes source "${m.source}" twice; the later description is ignored`, { file });
      continue;
    }
    described.add(m.source);
    const d = { source: m.source, resource: source.resource, type: m.type };
    if (m.duration !== undefined) d.duration = m.duration;
    if (m.digest !== undefined) d.digest = m.digest;
    if (m.transcript !== undefined) {
      const path = localWebVtt(file, sources.get(m.transcript)?.resource, files);
      if (path) {
        d.transcript = m.transcript;
        Object.defineProperty(d, 'transcriptPath', { value: path, enumerable: false });
      } else {
        diagnostics.add('C005_FIELD_INVALID', `media transcript "${m.transcript}" is not a source with a WebVTT file under sources/ or media/; it is dropped`, { file });
      }
    }
    // Package spec §5.7, caption tracks: each entry checked on its own; the description stands.
    if (Array.isArray(m.captions)) {
      const tracks = [];
      const seen = new Set();
      for (const c of m.captions) {
        const shaped = c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).every((k) => CAPTION_KEYS.has(k))
          && typeof c.source === 'string' && c.source !== '' && typeof c.language === 'string' && LANGUAGE_TAG.test(c.language)
          && (c.kind === undefined || CAPTION_KINDS.has(c.kind));
        if (!shaped) {
          diagnostics.add('C005_FIELD_INVALID', `media "${m.source}" has a caption track that is not { source, language, kind? } with a BCP 47 tag and an HTML track kind; it is dropped`, { file });
          continue;
        }
        if (!sources.has(c.source)) {
          diagnostics.add('C006_EVIDENCE_SOURCE_UNKNOWN', `media "${m.source}" has a caption track "${c.source}", which sources[] does not declare; it is dropped`, { file });
          continue;
        }
        if (seen.has(c.source)) {
          diagnostics.add('C005_FIELD_INVALID', `media "${m.source}" lists caption track "${c.source}" twice; the later one is dropped`, { file });
          continue;
        }
        if (!localWebVtt(file, sources.get(c.source)?.resource, files)) {
          diagnostics.add('C005_FIELD_INVALID', `media "${m.source}" caption track "${c.source}" is not a WebVTT file under sources/ or media/; it is dropped`, { file });
          continue;
        }
        seen.add(c.source);
        tracks.push({ source: c.source, language: c.language, kind: c.kind ?? 'subtitles' });
      }
      if (tracks.length > 0) d.captions = tracks;
    }
    out.push(d);
    raw.set(d, m);
  }
  // §5.7, Alternates: checked once every description is known, so the order of descriptions does not matter.
  for (const d of out) {
    const m = raw.get(d);
    if (m.alternateOf === undefined) {
      if (m.sync !== undefined) diagnostics.add('C005_FIELD_INVALID', `media "${d.source}" has sync but no alternateOf; sync is dropped`, { file });
      continue;
    }
    const ref = out.find((x) => x.source === m.alternateOf);
    const problem = !ref ? `names "${m.alternateOf}", which is no valid description in this node`
      : ref === d ? 'names itself'
        : raw.get(ref).alternateOf !== undefined ? `names "${ref.source}", which is an alternate itself`
          : syncProblem(m.sync ?? defaultSync());
    if (problem) {
      diagnostics.add('C005_FIELD_INVALID', `media "${d.source}" alternateOf ${problem}; alternateOf and sync are dropped`, { file });
      continue;
    }
    d.alternateOf = m.alternateOf;
    d.sync = (m.sync ?? defaultSync()).map((e) => ({ at: e.at, offset: e.offset }));
  }
  return out;
}

/**
 * Checks each moca.evidence selector against the cited file when that file is
 * inside the package and checkable (text, Markdown, HTML or WebVTT), after the
 * normalisation in evidence-text.js (Reader contract §7).
 * @returns {EvidenceCheck[]}
 */
function verifyEvidence(file, fm, files, bytes, diagnostics, limits, sourceText, media = []) {
  const evidence = fm.moca?.evidence;
  if (!Array.isArray(evidence)) return [];
  const sources = sourcesById(fm);
  const described = new Map(media.map((d) => [d.source, d]));
  return evidence.map((e, i) => {
    let path = localEvidencePath(file, sources.get(e?.source)?.resource, files);
    // Contract §7: a time range is checked against the cited WebVTT file, or the transcript of the cited media,
    // and bounded by the media's duration. A time range checked this way is evidence checkable in the package.
    let duration;
    let toReference;
    if (isMediaTimeRange(e?.selector) && (!path || sourceKind(path) !== 'webvtt')) {
      const d = described.get(e.source);
      if (d?.transcriptPath) {
        path = d.transcriptPath;
        duration = d.duration;
      } else if (d?.alternateOf !== undefined && described.get(d.alternateOf)?.transcriptPath) {
        // §5.7: an alternate with no transcript of its own is checked through its reference.
        const ref = described.get(d.alternateOf);
        path = ref.transcriptPath;
        duration = ref.duration;
        // An alternate's own duration bounds the range too, when it declares one.
        toReference = (range) => (typeof d.duration === 'number' && range.end !== Infinity && range.end > d.duration ? null : rangeToReference(d.sync, range));
      }
    } else if (path && sourceKind(path) === 'webvtt') {
      duration = media.find((d) => d.transcript === e.source)?.duration;
    }
    if (!path) return { local: false };
    const kind = sourceKind(path);
    if (!kind || !e.selector || typeof e.selector !== 'object') return { local: true };
    if (i >= limits.maxEvidencePerNode || bytes.get(path).length > limits.maxSourceBytesChecked) return { local: true };
    // Contract §3: one budget of checks and of source bytes scanned, shared by the package and its members.
    const { shared } = sourceText.budget;
    if (shared.checks >= limits.maxEvidenceChecksPerPackage) return { local: true };
    // Every check counts the source bytes it may scan against the budget.
    if (shared.bytes + bytes.get(path).length > limits.maxEvidenceBytesPerPackage) return { local: true };
    shared.bytes += bytes.get(path).length;
    shared.checks += 1;
    if (!sourceText.has(path)) sourceText.set(path, sourceString(bytes.get(path)));
    // Each source is normalised, and a WebVTT file's cues parsed, once per package, not once per check.
    const cacheKey = `${path}\u0000${kind}`;
    let prepared = sourceText.budget.prepared.get(cacheKey);
    if (!prepared) sourceText.budget.prepared.set(cacheKey, (prepared = {}));
    if (e.selector.type === 'FragmentSelector') {
      if (kind === 'webvtt' && !prepared.cues) prepared.cues = webvtt(sourceText.get(path)).cues;
    } else if (prepared.text === undefined) {
      prepared.text = normalisedText(sourceText.get(path), kind);
      prepared.codePoints = [...prepared.text].length;
    }
    const report = {};
    const matched = checkSelector(e.selector, sourceText.get(path), kind, prepared, { duration, toReference, report });
    if (matched === false) {
      diagnostics.add('C011_EVIDENCE_SELECTOR_UNMATCHED', `evidence ${e.selector.type} for source "${e.source}" does not match ${path}`, { file });
    }
    return matched === undefined ? { local: true } : { local: true, matched, ...(matched && report.located ? { located: report.located } : {}) };
  });
}

function checkWindow(file, validFrom, validUntil, diagnostics) {
  const from = parseInstant(validFrom);
  const until = parseInstant(validUntil);
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
    for (const written of linkTargets(line.replace(/`[^`]*`/g, ''))) {
      const target = written.replace(/^<|>$/g, '');
      if ((SCHEME.test(target) && !DRIVE.test(target)) || target.startsWith('#')) continue;
      const resolved = resolveReference(file, target);
      if (resolved.escapes) diagnostics.add('C008_UNSAFE_PATH', `link "${target}" ${resolved.reason}`, { file });
      else if (resolved.path && !files.has(resolved.path)) diagnostics.add('C007_LINK_UNRESOLVED', `link "${target}" does not resolve`, { file });
    }
  });
}
