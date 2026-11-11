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
 * Markdown to text:
 *   1. an image ![alt](url) becomes alt, a link [text](url) becomes text;
 *   2. per line, a leading ATX heading marker (#... and a space) and a leading
 *      list marker (-, *, + or a number with . or ), then a space) are removed;
 *   3. every *, _ and backtick is removed.
 */
export function markdownText(source) {
  return source
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
    .join('\n')
    .replace(/[*_`]/g, '');
}

/** HTML to text: script and style elements removed, tags removed, entities decoded. */
export function htmlText(source) {
  return decodeEntities(source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ''));
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
    const text = lines.slice(at + 1).map((l) => decodeEntities(l.replace(/<[^>]*>/g, ''))).join('\n');
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

export function checkSelector(selector, raw, kind, prepared) {
  if (selector.type === 'FragmentSelector') {
    if (!MEDIA_FRAGMENTS.test(selector.conformsTo ?? '') || kind !== 'webvtt') return undefined;
    const range = mediaTimeRange(selector.value);
    if (!range) return false;
    return webvtt(raw).cues.some((c) => range.start < c.end && range.end > c.start);
  }
  // The quote is normalised as the source is, so markup in either never decides a match.
  const quote = selector.type === 'TextQuoteSelector' ? normaliseQuote(selector, kind) : selector;
  if (prepared) return selectorMatches(quote, prepared.text, prepared.codePoints);
  return selectorMatches(quote, normalisedText(raw, kind));
}
