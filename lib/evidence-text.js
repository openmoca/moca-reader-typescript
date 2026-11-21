// Evidence checks against sources inside the package:
// spec/moca-reader-contract.md §7.
//
// W3C Web Annotation says selector text "MUST be normalized", with HTML and
// XML tags removed and character entities replaced. These are MOCA's exact
// normalisation rules per source type, so every Reader reaches the same
// answer. Positions count Unicode code points of the normalised text.

const KINDS = [
  [/\.(txt|text)$/i, 'text'],
  [/\.(md|markdown)$/i, 'markdown'],
  [/\.(html|htm)$/i, 'html'],
  [/\.vtt$/i, 'webvtt'],
];
const MEDIA_FRAGMENTS = /^https?:\/\/www\.w3\.org\/TR\/media-frags\/?$/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** The kind of a source path, or null when it is not checkable. */
export function sourceKind(path) {
  for (const [re, kind] of KINDS) if (re.test(path)) return kind;
  return null;
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A forward search for one string that remembers its last answer, so a run of searches from rising positions costs
 * one pass over the text in total, not one pass each.
 */
export function forwardFinder(text, needle) {
  let at = -2; // the last index found; -1 once there is none left
  return (from) => {
    if (at === -1) return -1;
    if (at < from) at = text.indexOf(needle, from);
    return at;
  };
}

/**
 * Step 1 of the Markdown rules below, in one pass: what `source.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')` gives,
 * without that expression's repeated scans.
 */
function linkText(source) {
  const open = forwardFinder(source, '[');
  const close = forwardFinder(source, ']');
  const paren = forwardFinder(source, ')');
  let out = '';
  let pos = 0;
  for (;;) {
    const i = open(pos);
    if (i < 0) break;
    const j = close(i + 1);
    if (j < 0) break;
    const end = source[j + 1] === '(' ? paren(j + 2) : -1;
    if (end < 0) {
      // No bracket between i and j opens a link either: they all close at j.
      if (source[j + 1] === '(') break; // and with no ")" left, nothing later is a link
      out += source.slice(pos, j + 1);
      pos = j + 1;
      continue;
    }
    const start = i > pos && source[i - 1] === '!' ? i - 1 : i;
    out += source.slice(pos, start) + source.slice(i + 1, j);
    pos = end + 1;
  }
  return out + source.slice(pos);
}

/** Every `<...>` removed, in one pass: what `text.replace(/<[^>]*>/g, '')` gives. */
function stripTags(text) {
  let out = '';
  let pos = 0;
  for (;;) {
    const i = text.indexOf('<', pos);
    if (i < 0) break;
    const j = text.indexOf('>', i + 1);
    if (j < 0) break;
    out += text.slice(pos, i);
    pos = j + 1;
  }
  return out + text.slice(pos);
}

/**
 * script and style elements removed, in one pass: what
 * `source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')` gives.
 */
function stripScriptAndStyle(source) {
  const opening = /<(script|style)\b/gi;
  const closing = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };
  const none = { script: false, style: false };
  const gt = forwardFinder(source, '>');
  let out = '';
  let pos = 0;
  for (;;) {
    opening.lastIndex = pos;
    const m = opening.exec(source);
    if (!m) break;
    const name = m[1].toLowerCase();
    const tagEnd = gt(opening.lastIndex);
    if (tagEnd < 0) break;
    let end = -1;
    if (!none[name]) {
      closing[name].lastIndex = tagEnd + 1;
      end = closing[name].exec(source) ? closing[name].lastIndex : -1;
      if (end < 0) none[name] = true;
    }
    if (end < 0) {
      // Not closed: the opening tag stays, and the search goes on after its name.
      if (none.script && none.style) break;
      out += source.slice(pos, opening.lastIndex);
      pos = opening.lastIndex;
      continue;
    }
    out += source.slice(pos, m.index);
    pos = end;
  }
  return out + source.slice(pos);
}

/**
 * Markdown to text:
 *   1. an image ![alt](url) becomes alt, a link [text](url) becomes text;
 *   2. per line, a leading ATX heading marker (#... and a space) and a leading
 *      list marker (-, *, + or a number with . or ), then a space) are removed;
 *   3. every *, _ and backtick is removed.
 */
export function markdownText(source) {
  return linkText(source)
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
    .join('\n')
    .replace(/[*_`]/g, '');
}

/** HTML to text: script and style elements removed, tags removed, entities decoded. */
export function htmlText(source) {
  return decodeEntities(stripTags(stripScriptAndStyle(source)));
}

function seconds(ts) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(ts.trim()) ?? /^(\d+(?:\.\d+)?)$/.exec(ts.trim());
  if (!m) return NaN;
  if (m.length === 2) return Number(m[1]);
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}

/**
 * WebVTT cues: their time ranges and payload text. The text is every cue's
 * payload lines, cue tags removed and entities decoded, joined with LF.
 */
export function webvtt(source) {
  const blocks = source.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks.slice(1)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, rest] = lines[at].split('-->');
    const start = seconds(from);
    const end = seconds(rest.trim().split(/\s+/)[0]);
    const text = lines.slice(at + 1).map((l) => decodeEntities(stripTags(l))).join('\n');
    if (Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text });
  }
  return { cues, text: cues.map((c) => c.text).join('\n') };
}

/** The normalised text of a source, by kind. */
export function normalisedText(raw, kind) {
  if (kind === 'markdown') return markdownText(raw);
  if (kind === 'html') return htmlText(raw);
  if (kind === 'webvtt') return webvtt(raw).text;
  return raw;
}

// Contract §7: in a refined quote, each run of these characters counts as one space.
const QUOTE_SPACE = /[\t\n\f\r ]+/g;

const isQuoteSpace = (ch) => ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r' || ch === ' ';

/** Every start index of `needle` in `text`, overlapping ones included, in one linear pass (Knuth-Morris-Pratt). */
export function occurrences(text, needle) {
  const m = needle.length;
  if (m === 0) return [];
  const fail = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = fail[k - 1];
    if (needle[i] === needle[k]) k += 1;
    fail[i] = k;
  }
  const out = [];
  for (let i = 0, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== needle[k]) k = fail[k - 1];
    if (text[i] === needle[k]) k += 1;
    if (k === m) {
      out.push(i - m + 1);
      k = fail[k - 1];
    }
  }
  return out;
}

/** A range-minimum (or maximum) table: query(lo, hi) over values[lo..hi] in O(1). */
function sparseTable(values, pick) {
  const levels = [Float64Array.from(values)];
  for (let w = 1; 2 * w <= values.length; w *= 2) {
    const prev = levels.at(-1);
    const next = new Float64Array(prev.length - w);
    for (let i = 0; i < next.length; i++) next[i] = pick(prev[i], prev[i + w]);
    levels.push(next);
  }
  return (lo, hi) => {
    const k = Math.floor(Math.log2(hi - lo + 1));
    return pick(levels[k][lo], levels[k][hi - (1 << k) + 1]);
  };
}

/**
 * Contract §7: where a refining quote is spoken in a time range. The covered text is the payloads of the cues the
 * range overlaps, in file order, joined with LF, with each run of white space (the five ASCII characters) as one
 * space, the quote's parts too. A cue is touched when a non-space character of `exact` comes from it. Of every
 * occurrence, the one whose touched cues span the shortest time wins, the earliest on a tie. Contract §3: linear in
 * the covered text and the quote.
 * @returns {{ start: number, end: number }|null} from the earliest start to the latest end of the touched cues;
 *   null when the quote is not in the covered text
 */
export function locateQuote(cues, range, quote) {
  if (typeof quote.exact !== 'string') return null;
  const part = (v) => (typeof v === 'string' ? v.replace(QUOTE_SPACE, ' ') : '');
  const exact = part(quote.exact);
  if (![...exact].some((ch) => !isQuoteSpace(ch))) return null;
  const prefix = part(quote.prefix);
  const needle = prefix + exact + part(quote.suffix);
  const covered = cues.filter((c) => range.start < c.end && range.end > c.start);
  const chars = [];
  const owner = [];
  covered.forEach((c, i) => {
    const piece = `${i > 0 ? '\n' : ''}${c.text}`;
    for (let k = 0; k < piece.length; k++) {
      const ch = piece[k];
      if (isQuoteSpace(ch)) {
        if (owner.length > 0 && owner[owner.length - 1] === -1) continue;
        chars.push(' ');
        owner.push(-1);
      } else {
        chars.push(ch);
        owner.push(i);
      }
    }
  });
  const text = chars.join('');
  const n = owner.length;
  // The owner of the first non-space character at or after each position, and of the last at or before it.
  const next = new Int32Array(n + 1).fill(-1);
  for (let i = n - 1; i >= 0; i--) next[i] = owner[i] >= 0 ? owner[i] : next[i + 1];
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) prev[i] = owner[i] >= 0 ? owner[i] : (i > 0 ? prev[i - 1] : -1);
  // Cues with text, in order: the touched cues of a span are those between its first and last owner.
  const rank = new Int32Array(covered.length).fill(-1);
  const filled = [];
  for (let i = 0; i < n; i++) if (owner[i] >= 0 && rank[owner[i]] < 0) { rank[owner[i]] = filled.length; filled.push(owner[i]); }
  if (filled.length === 0) return null;
  const earliest = sparseTable(filled.map((c) => covered[c].start), Math.min);
  const latest = sparseTable(filled.map((c) => covered[c].end), Math.max);
  let best = null;
  for (const at of occurrences(text, needle)) {
    const a = at + prefix.length;
    const b = a + exact.length;
    const first = next[a];
    if (first < 0 || prev[b - 1] < 0 || rank[first] > rank[prev[b - 1]]) continue;
    const span = { start: earliest(rank[first], rank[prev[b - 1]]), end: latest(rank[first], rank[prev[b - 1]]) };
    if (!best || span.end - span.start < best.end - best.start
      || (span.end - span.start === best.end - best.start && span.start < best.start)) best = span;
  }
  return best;
}

/** A FragmentSelector that conforms to Media Fragments: a time range in audio or video. */
export function isMediaTimeRange(selector) {
  return Boolean(selector) && typeof selector === 'object' && selector.type === 'FragmentSelector' && MEDIA_FRAGMENTS.test(selector.conformsTo ?? '');
}

/** Parses a Media Fragments temporal value `t=start[,end]` (seconds or hh:mm:ss), or null. */
export function mediaTimeRange(value) {
  const m = /(?:^|&)t=(?:npt:)?([^,&]*)(?:,([^&]*))?/.exec(String(value ?? ''));
  if (!m) return null;
  const start = m[1] === '' ? 0 : seconds(m[1]);
  const end = m[2] === undefined ? Infinity : seconds(m[2]);
  if (!Number.isFinite(start) || Number.isNaN(end) || end < start) return null;
  return { start, end };
}

/** @returns {boolean|undefined} undefined when the selector type is not checked */
export function selectorMatches(selector, text, codePoints) {
  if (selector.type === 'TextQuoteSelector') {
    if (typeof selector.exact !== 'string' || selector.exact === '') return false;
    const prefix = typeof selector.prefix === 'string' ? selector.prefix : '';
    const suffix = typeof selector.suffix === 'string' ? selector.suffix : '';
    // One search for prefix + exact + suffix: the same answer as checking each
    // occurrence of exact, without rescanning the text for every one.
    return text.includes(prefix + selector.exact + suffix);
  }
  // Contract §7: a TextPositionSelector on its own proves only that its offsets
  // are in range, not that the text is there, so it is not checked: `matched`
  // stays absent.
  if (selector.type === 'TextPositionSelector') return undefined;
  return undefined;
}

/**
 * Checks one selector against a source's raw text.
 * @returns {boolean|undefined} undefined when this selector cannot be checked against this source
 */
/** A TextQuoteSelector with exact, prefix and suffix normalised as the source is. */
function normaliseQuote(selector, kind) {
  // A quote from captions is cue text already; Markdown and HTML quotes lose markup as their sources do.
  if (kind !== 'markdown' && kind !== 'html') return selector;
  const part = (v) => (typeof v === 'string' ? normalisedText(v, kind) : v);
  return { ...selector, exact: part(selector.exact), prefix: part(selector.prefix), suffix: part(selector.suffix) };
}

export function checkSelector(selector, raw, kind, prepared, { duration, toReference, report } = {}) {
  if (selector.type === 'FragmentSelector') {
    if (!MEDIA_FRAGMENTS.test(selector.conformsTo ?? '') || kind !== 'webvtt') return undefined;
    const parsed = mediaTimeRange(selector.value);
    // Package spec §5.7: a range on an alternate is checked on its reference's timeline; one that does not map fails.
    const range = parsed && toReference ? toReference(parsed) : parsed;
    if (!range) return false;
    const cues = prepared?.cues ?? webvtt(raw).cues;
    if (!cues.some((c) => range.start < c.end && range.end > c.start)) return false;
    // Contract §7: the range lies within the media, bounded by the latest cue end or the declared duration.
    if (range.end !== Infinity) {
      // A loop, not Math.max(...cues): a long transcript has more cues than a call can take as arguments.
      let bound = typeof duration === 'number' ? duration : -Infinity;
      for (const c of cues) if (c.end > bound) bound = c.end;
      if (range.end > bound) return false;
    }
    // Contract §7: a range refined by a quote matches only when the quote is in the cues it covers.
    const refined = selector.refinedBy;
    if (!refined || typeof refined !== 'object' || refined.type !== 'TextQuoteSelector') return true;
    const located = locateQuote(cues, range, refined);
    if (!located) return false;
    // On an alternate, back to the cited source's timeline by the stretch's offset.
    const offset = parsed.start - range.start;
    if (report) report.located = { start: located.start + offset, end: located.end + offset };
    return true;
  }
  // The quote is normalised as the source is, so markup in either never decides a match.
  const quote = selector.type === 'TextQuoteSelector' ? normaliseQuote(selector, kind) : selector;
  if (prepared?.text !== undefined) return selectorMatches(quote, prepared.text, prepared.codePoints);
  return selectorMatches(quote, normalisedText(raw, kind));
}
