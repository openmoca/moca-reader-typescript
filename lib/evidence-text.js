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

// Contract §7: in a refined quote, each run of these characters counts as one space.
const QUOTE_SPACE = /[\t\n\f\r ]+/g;

/**
 * Contract §7: where a refining quote is spoken in a time range. The covered text is the payloads of the cues the
 * range overlaps, in file order, joined with LF, with each run of white space as one space (the quote's parts too).
 * Of every occurrence, the one whose cues span the shortest time wins, the earliest on a tie.
 * @returns {{ start: number, end: number }|null} from the start of the first cue the quote's text is in to the end
 *   of the last; null when the quote is not in the covered text
 */
export function locateQuote(cues, range, quote) {
  if (typeof quote.exact !== 'string') return null;
  const part = (v) => (typeof v === 'string' ? v.replace(QUOTE_SPACE, ' ') : '');
  const exact = part(quote.exact);
  if (exact.trim() === '') return null;
  const prefix = part(quote.prefix);
  const needle = prefix + exact + part(quote.suffix);
  const covered = cues.filter((c) => range.start < c.end && range.end > c.start);
  let text = '';
  const owner = [];
  covered.forEach((c, i) => {
    for (const ch of `${i > 0 ? '\n' : ''}${c.text}`.split('')) {
      if (/[\t\n\f\r ]/.test(ch)) {
        if (text.endsWith(' ') && owner.at(-1) === -1) continue;
        text += ' ';
        owner.push(-1);
      } else {
        text += ch;
        owner.push(i);
      }
    }
  });
  let best = null;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const own = owner.slice(at + prefix.length, at + prefix.length + exact.length).filter((o) => o >= 0);
    if (own.length === 0) continue;
    const span = { start: covered[own[0]].start, end: covered[own.at(-1)].end };
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
    const { cues } = webvtt(raw);
    if (!cues.some((c) => range.start < c.end && range.end > c.start)) return false;
    // Contract §7: the range lies within the media, bounded by the latest cue end or the declared duration.
    if (range.end !== Infinity) {
      const bound = Math.max(...cues.map((c) => c.end), typeof duration === 'number' ? duration : -Infinity);
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
  if (prepared) return selectorMatches(quote, prepared.text, prepared.codePoints);
  return selectorMatches(quote, normalisedText(raw, kind));
}
