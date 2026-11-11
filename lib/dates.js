// Dates and times (package spec §4.4, attestations §6): one rule for every date
// a Reader compares with its clock.
//
// - A full date (YYYY-MM-DD) means 00:00:00Z on that day.
// - A date-time is RFC 3339 and carries an offset (Z or ±hh:mm). Without one
//   it does not parse: a Reader never guesses a local time zone.
// - Anything else does not parse.

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * The instant a date or date-time names, in milliseconds since the epoch, or NaN.
 * @param {unknown} value
 * @returns {number}
 */
export function parseInstant(value) {
  if (typeof value !== 'string') return Number.NaN;
  const date = value.match(FULL_DATE);
  const dateTime = date ? null : value.match(DATE_TIME);
  const m = date ?? dateTime;
  if (!m) return Number.NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return Number.NaN;
  if (date) return day.getTime();
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (h > 23 || mi > 59 || s > 60) return Number.NaN;
  const t = Date.parse(value.toUpperCase());
  return Number.isNaN(t) ? Number.NaN : t;
}

/** True when `value` is a date or date-time that parses. */
export const isInstant = (value) => !Number.isNaN(parseInstant(value));

/**
 * The effective validity window of a node (package spec §4.4): the
 * intersection of the package's window and the node's own. A window whose end
 * is not after its start is ignored (it already has M006 or C010), as is a
 * bound that does not parse.
 * @returns {{ from?: string, until?: string, fromMs: number, untilMs: number }}
 */
export function effectiveWindow(packageFrom, packageUntil, nodeFrom, nodeUntil) {
  const window = (from, until) => {
    let f = parseInstant(from);
    let u = parseInstant(until);
    if (!Number.isNaN(f) && !Number.isNaN(u) && u <= f) { f = Number.NaN; u = Number.NaN; }
    return { f, u, from, until };
  };
  const p = window(packageFrom, packageUntil);
  const n = window(nodeFrom, nodeUntil);
  const pickFrom = Number.isNaN(n.f) ? p : Number.isNaN(p.f) || n.f >= p.f ? n : p;
  const pickUntil = Number.isNaN(n.u) ? p : Number.isNaN(p.u) || n.u <= p.u ? n : p;
  const fromMs = pickFrom.f;
  const untilMs = pickUntil.u;
  return {
    ...(Number.isNaN(fromMs) ? {} : { from: String(pickFrom.from) }),
    ...(Number.isNaN(untilMs) ? {} : { until: String(pickUntil.until) }),
    fromMs,
    untilMs,
  };
}
