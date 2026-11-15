// Package states (Reader contract §9.4): what a store search needs, per package,
// to recompute every field of a stored citation record that depends on the
// library or the trust root, without loading the package.
import { relationIndexOf } from './relations.js';
import { reviewStatusOf } from './reviews.js';
import { parseInstant } from './dates.js';
import { readingOrderOf } from './reader.js';
import { readingOrderState } from './reading-order.js';
import { compositionOf } from './composition.js';

/**
 * A package's state, as plain JSON a host can keep beside its store.
 * @param {object} result  a valid package result from readPackage
 */
export function packageState(result) {
  const contests = {};
  for (const node of result.nodes) {
    for (const rep of node.representations) {
      const list = rep.frontmatter?.moca?.contested_by;
      if (Array.isArray(list) && list.length > 0) contests[rep.file] = [...list];
    }
  }
  return {
    digest: result.digest,
    id: result.manifest.id,
    version: result.manifest.version,
    ...(typeof result.manifest.language === 'string' ? { language: result.manifest.language } : {}),
    relations: Array.isArray(result.manifest.relations) ? result.manifest.relations : [],
    relationScopes: [...(result.relationScopes ?? [])],
    signers: [...result.signers],
    reviews: Object.fromEntries(result.reviewsByFile),
    contests,
    ...(result.issuedCopy ? { issuedCopy: { ...result.issuedCopy, issuers: [...result.issuedCopy.issuers], changedFiles: [...result.issuedCopy.changedFiles] } } : {}),
    ...(readingOrderOf(result) ? { readingOrder: readingOrderState(readingOrderOf(result)) } : {}),
    // Contract §9.4: the bindings by composition, so a store search filters and limits members as a library does.
    ...(compositionOf(result).length > 0 ? { composition: compositionOf(result) } : {}),
  };
}

/** The node file a record cites, from its path and locale. */
function fileOf(record, state) {
  const { path, locale } = record.node;
  if (!locale || locale === state.language) return `content/${path}`;
  return `content/${path.replace(/\.md$/i, '')}.${locale}.md`;
}

/**
 * A stored record with every library- and trust-dependent field recomputed
 * from the current package states and clock; null when its package is not
 * among them.
 */
export function refreshRecord(record, now, states, index) {
  const state = states.get(record.package?.digest);
  if (!state) return null;
  const t = now.getTime();
  const trust = { ...record.trust };
  trust.stale = trust.staleAfter ? t >= parseInstant(trust.staleAfter) : false;
  trust.inForce = (!trust.validFrom || t >= parseInstant(trust.validFrom)) && (!trust.validUntil || t < parseInstant(trust.validUntil));
  const key = `${state.id}@${state.version}`;
  const file = fileOf(record, state);
  const supersededBy = index.superseded.get(key) ?? [];
  const contestedBy = [...(state.contests?.[file] ?? []), ...(index.contested.get(key) ?? [])];
  trust.superseded = supersededBy.length > 0;
  if (supersededBy.length > 0) trust.supersededBy = supersededBy; else delete trust.supersededBy;
  trust.contested = contestedBy.length > 0;
  if (contestedBy.length > 0) trust.contestedBy = contestedBy; else delete trust.contestedBy;
  const signed = state.signers.length > 0;
  const reviews = state.reviews?.[file] ?? [];
  trust.attestedReviews = reviews.map((r) => ({ ...r, packageVerified: signed }));
  trust.reviewStatus = reviewStatusOf(reviews, signed);
  const pkg = { ...record.package, signed };
  if (signed) pkg.signers = [...state.signers]; else delete pkg.signers;
  // Attestations §7.1: whether the copy is bound to its publisher depends on the trust root, so it comes from the state.
  const issued = state.issuedCopy;
  if (issued) pkg.issuedCopy = { originalDigest: issued.originalDigest, issuers: [...issued.issuers] }; else delete pkg.issuedCopy;
  const node = { ...record.node };
  if (issued?.changedFiles?.includes(file)) node.issuedChange = true; else delete node.issuedChange;
  return { ...record, package: pkg, node, trust };
}

/** The relation index over a set of package states. */
export const stateIndex = (states, options) => relationIndexOf([...states.values()], options);
