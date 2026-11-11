// Review status (package spec §11, Reader contract §7, moca-spec ADR-0017).

/**
 * The review status of a node representation:
 * - `none`: no current review;
 * - `unverified`: reviews exist, but the package is not signed, so who
 *   published the reviewed bytes is unproven;
 * - `approved`: signed, at least one current review is `accurate`, and none
 *   says otherwise;
 * - `disputed`: signed, and a current review says `needs-change` or
 *   `inaccurate`.
 * @param {Array<{ outcome: string }>|undefined} reviews
 * @param {boolean} signed
 */
export function reviewStatusOf(reviews, signed) {
  if (!reviews || reviews.length === 0) return 'none';
  if (!signed) return 'unverified';
  if (reviews.some((r) => r.outcome !== 'accurate')) return 'disputed';
  return 'approved';
}
