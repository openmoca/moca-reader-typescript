// Lower-casing, defined once (package spec §6.3): each code point is replaced
// with its Unicode simple lowercase mapping, one at a time, with no language
// or context rules. İ (U+0130) becomes i, and Σ always becomes σ.

/** The simple lowercase mapping of one code point, as a string. */
export function lowerCodePoint(ch) {
  const l = ch.toLowerCase();
  // toLowerCase applies special casing: İ gives i + U+0307. The simple mapping is i.
  if (l === 'i̇') return 'i';
  // Final sigma never applies to a lone code point; any other multi-code-point
  // result has no simple mapping, so the code point stays as it is.
  return [...l].length === 1 ? l : ch;
}

/** A string lower-cased one code point at a time. */
export function simpleLowercase(text) {
  let out = '';
  for (const ch of text) out += lowerCodePoint(ch);
  return out;
}
