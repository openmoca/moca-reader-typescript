// Choosing by language: package spec §5.4 (RFC 4647 §3.4 Lookup, with MOCA's two additions).

/** Package spec §5.4: a priority list keeps at most this many entries. */
export const MAX_LOCALE_ENTRIES = 16;
/** Package spec §5.4: a longer entry is dropped (RFC 5646 §4.4.1 suggests 35 characters). */
export const MAX_LOCALE_TAG = 35;

/**
 * A request for a locale as a priority list: one tag is the list of that tag, a list keeps its string entries in
 * order, and anything else (an empty list included) is no request. Package spec §5.4: an entry longer than 35
 * characters is dropped, and only the first 16 entries are kept.
 * @param {string|string[]|undefined|null} locale
 * @returns {string[]}
 */
export function localeList(locale) {
  return trimmedLocales(locale).list;
}

/** As localeList, with how many entries were dropped (for S014). */
export function trimmedLocales(locale) {
  const all = typeof locale === 'string' ? [locale] : Array.isArray(locale) ? locale : [];
  const strings = all.filter((l) => typeof l === 'string' && l !== '');
  const fitting = strings.filter((l) => l.length <= MAX_LOCALE_TAG);
  const list = fitting.slice(0, MAX_LOCALE_ENTRIES);
  return { list, dropped: strings.length - list.length };
}

/** The script subtag of a tag (its second subtag when it is four letters), lower-cased, or null. */
function scriptOf(tag) {
  const parts = tag.toLowerCase().split('-');
  return parts.length > 1 && /^[a-z]{4}$/.test(parts[1]) ? parts[1] : null;
}

/** The range, then each RFC 4647 §3.4 truncation of it: a trailing single-character subtag goes with the one after it. */
function truncations(range) {
  const out = [];
  const parts = range.toLowerCase().split('-');
  while (parts.length > 0) {
    out.push(parts.join('-'));
    parts.pop();
    if (parts.length > 1 && parts[parts.length - 1].length === 1) parts.pop();
  }
  return out;
}

const byTag = (a, b) => (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0);

/**
 * Package spec §5.4: for each entry of the priority list, and each truncation of it, the candidate whose tag equals
 * it, else the lowest candidate whose tag starts with it and `-` (MOCA's addition to RFC 4647 Lookup; when the entry
 * names a script, a candidate that names another script is not such a match). Candidates with no tag are never
 * matched here.
 * @template T
 * @param {Array<{ tag: string|null|undefined, value: T }>} candidates
 * @param {string|string[]} locale
 * @returns {T|undefined}
 */
export function lookup(candidates, locale) {
  const tagged = candidates.filter((c) => typeof c.tag === 'string' && c.tag !== '').map((c) => ({ ...c, lower: c.tag.toLowerCase() }));
  for (const range of localeList(locale)) {
    const script = scriptOf(range);
    for (const prefix of truncations(range)) {
      const exact = tagged.find((c) => c.lower === prefix);
      if (exact) return exact.value;
      const longer = tagged.filter((c) => c.lower.startsWith(`${prefix}-`) && (script === null || scriptOf(c.lower) === null || scriptOf(c.lower) === script)).sort(byTag)[0];
      if (longer) return longer.value;
    }
  }
  return undefined;
}

/** Whether a language tag matches a request: the lookup over that one tag selects it. */
export function localeMatches(tag, locale) {
  return lookup([{ tag, value: true }], locale) === true;
}

/** A representation's tag: a translation's own, or, for the default representation, the node's language. */
export function representationTag(node, rep) {
  return rep.locale ?? node.language ?? null;
}
