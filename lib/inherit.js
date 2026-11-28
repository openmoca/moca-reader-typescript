// What a translation takes from its default file: package spec §5.4.
//
// A translation that does not write `moca.audience`, `moca.concepts`, OKF `status`, OKF `stale_after`,
// `moca.valid_from`, `moca.valid_until` or `moca.contested_by` has its default representation's value for each, on
// its own. A key the translation writes is its own, even when its value is invalid. Every rule that reads one of these
// keys goes through `inherited` (or `sourceOf`), so they all find the default file the same way.

/** The node's default-language representation, or undefined for an orphan translation (C009). */
export function defaultRepresentation(node) {
  return node?.representations?.find((r) => r.locale === null);
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** OKF keys at the top level of the front matter; every other inherited key is under `moca`. */
const TOP_LEVEL = new Set(['status', 'stale_after']);

/** Whether a frontmatter writes a key: `status` and `stale_after` at the top level, any other under `moca`. */
function writes(fm, key) {
  if (TOP_LEVEL.has(key)) return isObject(fm) && Object.hasOwn(fm, key);
  return isObject(fm?.moca) && Object.hasOwn(fm.moca, key);
}

function valueIn(fm, key) {
  return TOP_LEVEL.has(key) ? (isObject(fm) ? fm[key] : undefined) : (isObject(fm?.moca) ? fm.moca[key] : undefined);
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
