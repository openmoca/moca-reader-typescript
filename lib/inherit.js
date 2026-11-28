// What a translation takes from its default file: package spec §5.4.
//
// A translation that does not write `moca.audience`, `moca.concepts`, OKF `status`, `moca.valid_from` or
// `moca.valid_until` has its default representation's value for each, on its own. A key the translation writes is
// its own, even when its value is invalid.

/** The node's default-language representation, or undefined for an orphan translation (C009). */
export function defaultRepresentation(node) {
  return node?.representations?.find((r) => r.locale === null);
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Whether a frontmatter writes a key: `status` at the top level, any other under `moca`. */
function writes(fm, key) {
  if (key === 'status') return isObject(fm) && Object.hasOwn(fm, 'status');
  return isObject(fm?.moca) && Object.hasOwn(fm.moca, key);
}

function valueIn(fm, key) {
  return key === 'status' ? fm?.status : (isObject(fm?.moca) ? fm.moca[key] : undefined);
}

/**
 * The representation whose value of `key` applies to `rep`: its own when it writes the key, else, for a
 * translation, its default representation's.
 */
export function sourceOf(node, rep, key) {
  if (rep.locale === null || writes(rep.frontmatter, key)) return rep;
  return defaultRepresentation(node) ?? rep;
}

/** The value of `key` that applies to `rep` (package spec §5.4). */
export function inherited(node, rep, key) {
  return valueIn(sourceOf(node, rep, key).frontmatter, key);
}
