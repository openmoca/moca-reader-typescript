// Package states (Reader contract §9.4): what a store search needs, per package,
// to recompute every field of a stored citation record that depends on the
// library or the trust root, without loading the package.
import { relationIndexOf } from './relations.js';
import { inherited } from './inherit.js';
import { reviewStatusOf } from './reviews.js';
import { parseInstant } from './dates.js';
import { readingOrderOf, termsSourceOf } from './reader.js';
import { readingOrderState } from './reading-order.js';
import { compositionOf } from './composition.js';
import { representationTag } from './locale.js';
import { citationFor } from './citation.js';
import { fileSummary } from './availability.js';

/**
 * A package's state, as plain JSON a host can keep beside its store.
 * @param {object} result  a valid package result from readPackage
 */
export function packageState(result) {
  const contests = {};
  for (const node of result.nodes) {
    for (const rep of node.representations) {
      // Package spec §5.4: a translation's contests are its default file's unless it writes its own.
      const list = inherited(node, rep, 'contested_by');
      if (Array.isArray(list) && list.length > 0) contests[rep.file] = [...list];
    }
  }
  return {
    digest: result.digest,
    id: result.manifest.id,
    version: result.manifest.version,
    ...(typeof result.manifest.language === 'string' ? { language: result.manifest.language } : {}),
    // Package spec §4.4 and §7.4: the package's own window, so a store search knows whether a composite folds.
    ...(typeof result.manifest.validFrom === 'string' ? { validFrom: result.manifest.validFrom } : {}),
    ...(typeof result.manifest.validUntil === 'string' ? { validUntil: result.manifest.validUntil } : {}),
    // Package spec §7.4: what its files can return, so a store search chooses only among editions it can return.
    files: fileSummary(result),
    // Contract §9.4: the files of each node with more than one, so a store search chooses one per node as a library does.
    representations: representationsOf(result),
    // Package spec §5.3: the nodes whose default file gives its own language, so a stored record's file is known.
    ...(nodeLanguages(result) ? { nodeLanguages: nodeLanguages(result) } : {}),
    relations: Array.isArray(result.manifest.relations) ? result.manifest.relations : [],
    relationScopes: [...(result.relationScopes ?? [])],
    signers: [...result.signers],
    reviews: Object.fromEntries(result.reviewsByFile),
    contests,
    ...(result.issuedCopy ? { issuedCopy: { ...result.issuedCopy, issuers: [...result.issuedCopy.issuers], changedFiles: [...result.issuedCopy.changedFiles] } } : {}),
    ...(readingOrderOf(result) ? { readingOrder: readingOrderState(readingOrderOf(result)) } : {}),
    // Contract §9.4: the bindings by composition, so a store search filters and limits members as a library does.
    ...(compositionOf(result) ? { composition: compositionOf(result) } : {}),
    // Contract §15.3: what resolving the package's terms needs, so a store search applies a terms request too.
    ...(termsSourceOf(result) ? { terms: termsSourceOf(result) } : {}),
  };
}

/**
 * Contract §9.4: path -> the node's representations, the default first, for each node with more than one. Each is
 * `{ tag, default }`, `tag` absent when the file has none, with what steps 5.2 and 5.3 of the gate read: `status`,
 * `validFrom` and `validUntil` (the window the file ends up with) and `audience` (or `audienceInvalid`), as its
 * citation record carries them.
 */
function representationsOf(result) {
  const out = {};
  for (const node of result.nodes) {
    if (node.representations.length < 2) continue;
    const list = node.representations.map((rep) => {
      const { trust, audience, audienceInvalid } = citationFor(result, node, rep);
      return {
        ...(representationTag(node, rep) ? { tag: representationTag(node, rep) } : {}),
        ...(rep.locale === null ? { default: true } : {}),
        status: trust.status,
        ...(trust.validFrom ? { validFrom: trust.validFrom } : {}),
        ...(trust.validUntil ? { validUntil: trust.validUntil } : {}),
        ...(audience !== undefined ? { audience } : {}),
        ...(audienceInvalid ? { audienceInvalid: true } : {}),
      };
    });
    Object.defineProperty(out, node.path, { value: list, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * A node as the lookup sees it, from a state's list of its representations (contract §9.4); null when the state
 * lists none for the path (one representation, or a state from before 0.8.0).
 */
export function storedNode(state, path) {
  const files = state?.representations;
  if (!files || typeof files !== 'object' || !Object.hasOwn(files, path) || !Array.isArray(files[path])) return null;
  const list = files[path].filter((f) => f && typeof f === 'object');
  const language = list.find((f) => f.default === true)?.tag;
  return {
    ...(typeof language === 'string' ? { language } : {}),
    representations: list.map((f) => ({ ...f, locale: f.default === true ? null : (typeof f.tag === 'string' ? f.tag : null) })),
  };
}

/**
 * Contract §9.2 steps 5.2 and 5.3 for a file a state lists: whether the default retrieval policy and the audience set
 * keep it now. `superseded` is the package's, from the relations among the loaded packages.
 */
export function storedFileKept(file, { now, superseded, includeAll, audiences, allowUnlabelled, audienceAllowed }) {
  if (!includeAll) {
    const t = now.getTime();
    const from = typeof file.validFrom === 'string' ? parseInstant(file.validFrom) : NaN;
    const until = typeof file.validUntil === 'string' ? parseInstant(file.validUntil) : NaN;
    const inForce = (Number.isNaN(from) || t >= from) && (Number.isNaN(until) || t < until);
    if (!inForce || superseded || file.status === 'deprecated') return false;
  }
  return audienceAllowed({ label: typeof file.audience === 'string' ? file.audience : undefined, invalid: file.audienceInvalid === true }, audiences, allowUnlabelled);
}

/** Package spec §5.3: path -> language for each node whose default file sets moca.language; undefined for none. */
function nodeLanguages(result) {
  const out = {};
  let any = false;
  for (const node of result.nodes) {
    if (typeof node.language === 'string' && node.language !== result.manifest.language) {
      Object.defineProperty(out, node.path, { value: node.language, enumerable: true, writable: true, configurable: true });
      any = true;
    }
  }
  return any ? out : undefined;
}

/** The node file a record cites, from its path and locale: the default file when the locale is its node's language. */
function fileOf(record, state) {
  const { path, locale } = record.node;
  const own = state.nodeLanguages && Object.hasOwn(state.nodeLanguages, path) ? state.nodeLanguages[path] : state.language;
  if (!locale || locale === own) return `content/${path}`;
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
