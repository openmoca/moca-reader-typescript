// Package spec §5.7, "Alternates": media descriptions of one node that carry the same content on timelines that line
// up stretch by stretch. Each entry of `sync` starts a stretch of the reference, from its `at` up to the next entry's
// `at`; the last runs to the end. A stretch with an offset is on the alternate at `t + offset`; one whose offset is
// null is not in the alternate.

const IDENTITY = Object.freeze([Object.freeze({ at: 0, offset: 0 })]);

/** The default sync of an alternate that gives none: the reference's timeline unchanged. */
export function defaultSync() {
  return IDENTITY.map((e) => ({ ...e }));
}

/** Why a sync list cannot be used (`at` out of order, or stretches that overlap on the alternate), or null. */
export function syncProblem(sync) {
  for (let i = 1; i < sync.length; i++) {
    if (!(sync[i].at > sync[i - 1].at)) return 'its "at" values are not in strictly increasing order';
  }
  const mapped = stretches(sync).filter((s) => s.offset !== null).sort((a, b) => a.lo - b.lo);
  for (let i = 1; i < mapped.length; i++) {
    if (mapped[i - 1].hi > mapped[i].lo) return 'two of its stretches overlap on the alternate\'s timeline';
  }
  return null;
}

/** Each stretch: its reference span [from, to), and, when it has an offset, its alternate span [lo, hi). */
function stretches(sync) {
  return sync.map((e, i) => {
    const to = i + 1 < sync.length ? sync[i + 1].at : Infinity;
    return e.offset === null
      ? { from: e.at, to, offset: null }
      : { from: e.at, to, offset: e.offset, lo: e.at + e.offset, hi: to + e.offset };
  });
}

/** A moment on the reference, on the alternate; null when its stretch is not in the alternate. */
export function toAlternate(sync, t) {
  const s = stretches(sync).findLast((x) => x.from <= t);
  return s && s.offset !== null && t < s.to ? t + s.offset : null;
}

/** A moment on the alternate, on the reference; null when it lies in no stretch. */
export function toReference(sync, t) {
  const s = stretches(sync).find((x) => x.offset !== null && x.lo <= t && t < x.hi);
  return s ? t - s.offset : null;
}

/**
 * A time range on the alternate, on the reference: it maps when its start and end lie in one stretch (the end may
 * equal the stretch's last moment). A range with no end keeps none. Null when it does not map.
 */
export function rangeToReference(sync, range) {
  const s = stretches(sync).find((x) => x.offset !== null && x.lo <= range.start && range.start < x.hi);
  if (!s) return null;
  if (range.end === Infinity) return { start: range.start - s.offset, end: Infinity };
  return range.end <= s.hi ? { start: range.start - s.offset, end: range.end - s.offset } : null;
}

const within = (t, d) => Number.isFinite(t) && t >= 0 && (typeof d?.duration !== 'number' || t <= d.duration);

/**
 * Reader interface §4: the same moment on another media description of the record's node, or null when it is not
 * there. A description maps a moment on its own timeline to itself; two alternates of one reference map through it.
 * @param {object} record  a citation record
 * @param {string} from    the `source` of the description the moment is on
 * @param {string} to      the `source` of the description to map it to
 * @param {number} t       the moment, in seconds
 * @returns {number|null}
 */
export function mapTime(record, from, to, t) {
  const media = Array.isArray(record?.node?.media) ? record.node.media : [];
  const a = media.find((d) => d.source === from);
  const b = media.find((d) => d.source === to);
  if (!a || !b || typeof t !== 'number' || !within(t, a)) return null;
  if (a === b) return t;
  const refId = a.alternateOf ?? a.source;
  if ((b.alternateOf ?? b.source) !== refId) return null;
  const ref = media.find((d) => d.source === refId);
  if (!ref) return null;
  const onRef = a.alternateOf === undefined ? t : toReference(a.sync ?? IDENTITY, t);
  if (onRef === null || !within(onRef, ref)) return null;
  const out = b.alternateOf === undefined ? onRef : toAlternate(b.sync ?? IDENTITY, onRef);
  return out !== null && within(out, b) ? out : null;
}
