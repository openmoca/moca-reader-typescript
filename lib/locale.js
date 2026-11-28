// Choosing by language: package spec §5.4 (RFC 4647 §3.4 Lookup, with MOCA's two additions).

/**
 * A request for a locale as a priority list: one tag is the list of that tag, a list keeps its string entries in
 * order, and anything else (an empty list included) is no request.
 * @param {string|string[]|undefined|null} locale
 * @returns {string[]}
 */
export function localeList(locale) {
  if (typeof locale === 'string') return locale === '' ? [] : [locale];
  if (Array.isArray(locale)) return locale.filter((l) => typeof l === 'string' && l !== '');
  return [];
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
 * it, else the lowest candidate whose tag starts with it and `-`. Candidates with no tag are never matched here.
 * @template T
 * @param {Array<{ tag: string|null|undefined, value: T }>} candidates
 * @param {string|string[]} locale
 * @returns {T|undefined}
 */
export function lookup(candidates, locale) {
  const tagged = candidates.filter((c) => typeof c.tag === 'string' && c.tag !== '').map((c) => ({ ...c, lower: c.tag.toLowerCase() }));
  for (const range of localeList(locale)) {
    for (const prefix of truncations(range)) {
      const exact = tagged.find((c) => c.lower === prefix);
      if (exact) return exact.value;
      const longer = tagged.filter((c) => c.lower.startsWith(`${prefix}-`)).sort(byTag)[0];
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
