// What a package can return to a search: package spec §7.4 ("Choosing") and Reader contract §9.2 step 5.4, §9.4.
//
// A slot chooses only among editions the search can return, so it never leaves a reader who could see one of its
// editions with none. Whether a package can return anything depends on steps 5.1 to 5.3 of the gate (and the terms
// gate, with a request), applied to each of its files. A package's file summary holds what those steps read, each
// distinct combination once, so a library search and a store search (from the package state) decide alike.
import { citationFor } from './citation.js';
import { termsSourceOf } from './reader.js';
import { parseInstant } from './dates.js';
import { audienceAllowed } from './audience.js';

const summaries = new WeakMap();

/**
 * Contract §9.4: the distinct combinations of what steps 5.2 and 5.3 read over every file of a package: `status`,
 * `validFrom` and `validUntil` (the window the file ends up with) and `audience` (or `audienceInvalid`); with `path`
 * too when the package's terms have node-level entries, so the terms gate can be applied to it. Ordered.
 * @param {object} result  a valid package result
 */
export function fileSummary(result) {
  if (result && typeof result === 'object' && summaries.has(result)) return summaries.get(result);
  const byPath = termsSourceOf(result)?.terms?.nodes !== undefined;
  const seen = new Map();
  for (const node of result?.nodes ?? []) {
    for (const rep of node.representations) {
      const { trust, audience, audienceInvalid } = citationFor(result, node, rep);
      const entry = {
        status: trust.status,
        ...(trust.validFrom ? { validFrom: trust.validFrom } : {}),
        ...(trust.validUntil ? { validUntil: trust.validUntil } : {}),
        ...(audience !== undefined ? { audience } : {}),
        ...(audienceInvalid ? { audienceInvalid: true } : {}),
        ...(byPath ? { path: node.path } : {}),
      };
      const key = JSON.stringify(entry);
      if (!seen.has(key)) seen.set(key, entry);
    }
  }
  const out = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
  if (result && typeof result === 'object') summaries.set(result, out);
  return out;
}

/**
 * Contract §9.2 steps 5.2 and 5.3 for one entry of a file summary or one file a state lists: whether the default
 * retrieval policy (unless the host opted in) and the audience set keep it now. `superseded` is the package's.
 */
export function fileKept(file, { now, superseded, includeAll, audiences, allowUnlabelled }) {
  if (!file || typeof file !== 'object') return false;
  if (!includeAll) {
    const t = now.getTime();
    const from = typeof file.validFrom === 'string' ? parseInstant(file.validFrom) : NaN;
    const until = typeof file.validUntil === 'string' ? parseInstant(file.validUntil) : NaN;
    const inForce = (Number.isNaN(from) || t >= from) && (Number.isNaN(until) || t < until);
    if (!inForce || superseded || file.status === 'deprecated') return false;
  }
  return audienceAllowed({ label: typeof file.audience === 'string' ? file.audience : undefined, invalid: file.audienceInvalid === true }, audiences, allowUnlabelled);
}

/**
 * Whether any file of a summary passes steps 5.2 and 5.3 and, when `terms` is given, the terms gate (a function of
 * the entry's `path`, or null for the package level).
 */
export function summaryPasses(files, options, terms) {
  if (!Array.isArray(files)) return true;
  return files.some((f) => fileKept(f, options) && (!terms || terms(typeof f?.path === 'string' ? f.path : null)));
}

/** Package spec §4.4: whether a package's own window holds now (a bound that does not parse is ignored). */
export function packageInForce(validFrom, validUntil, now) {
  const t = now.getTime();
  const from = typeof validFrom === 'string' ? parseInstant(validFrom) : NaN;
  const until = typeof validUntil === 'string' ? parseInstant(validUntil) : NaN;
  if (!Number.isNaN(from) && !Number.isNaN(until) && until <= from) return true;
  return (Number.isNaN(from) || t >= from) && (Number.isNaN(until) || t < until);
}
