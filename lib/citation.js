// Citation records and the default retrieval policy.
// See spec/moca-reader-contract.md §7 and §8.

import { reviewStatusOf } from './reviews.js';
import { audienceOf } from './audience.js';
import { effectiveWindow, isInstant, parseInstant } from './dates.js';
import { sourcesById } from './content.js';

/** The default retrieval policy, spec/moca-reader-contract.md §8. */
export function passesDefaultPolicy(record) {
  return record.trust.inForce && !record.trust.superseded && record.trust.status !== 'deprecated';
}

export function pickRepresentation(node, locale) {
  if (!locale) return node.representations[0];
  const want = locale.toLowerCase();
  // Package spec §5.4: exact; then the longest tag the request starts with (RFC 4647
  // Lookup); then the lowest tag, in code-point order, that starts with the request.
  const tagged = node.representations.filter((r) => r.locale);
  const byLength = (a, b) => b.locale.length - a.locale.length;
  const byTag = (a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0);
  return tagged.find((r) => r.locale.toLowerCase() === want)
    ?? tagged.filter((r) => want.startsWith(`${r.locale.toLowerCase()}-`)).sort(byLength)[0]
    ?? tagged.filter((r) => r.locale.toLowerCase().startsWith(`${want}-`)).sort(byTag)[0]
    ?? node.representations[0];
}

/** An OKF `generated` or `verified` entry that names its actor. */
function hasActor(entry) {
  return Boolean(entry) && typeof entry === 'object' && entry.by !== undefined && entry.by !== null && String(entry.by) !== '';
}

/**
 * Builds one citation record (schemas/v1/citation-record.schema.json).
 */
export function citationFor(result, node, rep, { now = new Date(), index, text } = {}) {
  const { manifest } = result;
  const fm = rep.frontmatter;
  const moca = fm.moca && typeof fm.moca === 'object' ? fm.moca : {};
  const key = `${manifest.id}@${manifest.version}`;
  // Package spec §4.4: the node's window is the intersection of the package's
  // and its own. A bound that does not parse, or a window whose end is not after
  // its start, is ignored (it already has a diagnostic): it never takes a node
  // out of force.
  const audience = audienceOf(node, rep);
  const window = effectiveWindow(manifest.validFrom, manifest.validUntil, moca.valid_from, moca.valid_until);
  const validFrom = window.from;
  const validUntil = window.until;
  const staleAfter = isInstant(fm.stale_after) ? fm.stale_after : undefined;
  const t = now.getTime();
  const supersededBy = index?.superseded.get(key) ?? [];
  const contestedBy = [...(Array.isArray(moca.contested_by) ? moca.contested_by : []), ...(index?.contested.get(key) ?? [])];
  const sources = sourcesById(fm);

  const record = {
    package: {
      id: manifest.id,
      version: manifest.version,
      digest: result.digest,
      signed: result.signers.length > 0,
      ...(result.signers.length > 0 ? { signers: [...result.signers] } : {}),
      // Attestations §7.1: an issued copy names its original digest and issuers.
      ...(result.issuedCopy ? { issuedCopy: { originalDigest: result.issuedCopy.originalDigest, issuers: [...result.issuedCopy.issuers] } } : {}),
      // Package spec §4.12: informative, as written.
      ...(typeof result.datePublished === 'string' ? { datePublished: result.datePublished } : {}),
    },
    node: {
      id: `${manifest.id}#${node.path}`,
      ref: `${manifest.id}@${manifest.version}#${node.path}`,
      path: node.path,
      ...(rep.locale ? { locale: rep.locale } : manifest.language ? { locale: manifest.language } : {}),
      type: fm.type,
      ...(typeof fm.title === 'string' ? { title: fm.title } : {}),
      ...(typeof fm.description === 'string' ? { description: fm.description } : {}),
      ...(Array.isArray(fm.tags) ? { tags: fm.tags.filter((x) => typeof x === 'string') } : {}),
      ...(rep.sha256 ? { digest: `sha256:${rep.sha256}` } : {}),
      ...(result.issuedCopy?.changedFiles.includes(rep.file) ? { issuedChange: true } : {}),
      // Package spec §4.12: the node's own date, never the package's; absent when it does not parse.
      ...(typeof moca.date_published === 'string' && isInstant(moca.date_published) ? { datePublished: moca.date_published } : {}),
      // Package spec §4.13: the node's own credits, never the package's.
      ...(rep.contributors ? { contributors: structuredClone(rep.contributors) } : {}),
      // Package spec §5.7: the valid media descriptions, in order.
      ...(rep.media?.length > 0 ? { media: rep.media.map((d) => ({ ...d, ...(d.sync ? { sync: d.sync.map((e) => ({ ...e })) } : {}) })) } : {}),
    },
    span: { start: rep.bodyOffset, end: rep.bodyOffset + Buffer.byteLength(rep.body) },
    trust: {
      status: ['draft', 'stable', 'deprecated'].includes(fm.status) ? fm.status : 'stable',
      // An entry with no actor (`by`) is dropped rather than reported as "undefined".
      generated: hasActor(fm.generated) ? { by: String(fm.generated.by), ...(fm.generated.at ? { at: String(fm.generated.at) } : {}) } : null,
      declaredVerified: (Array.isArray(fm.verified) ? fm.verified : fm.verified ? [fm.verified] : [])
        .filter(hasActor)
        .map((v) => ({ by: String(v.by), ...(v.at ? { at: String(v.at) } : {}) })),
      attestedReviews: (result.reviewsByFile.get(rep.file) ?? []).map((r) => ({ ...r, packageVerified: result.signers.length > 0 })),
      reviewStatus: reviewStatusOf(result.reviewsByFile.get(rep.file), result.signers.length > 0),
      ...(staleAfter ? { staleAfter: String(staleAfter) } : {}),
      ...(validFrom ? { validFrom: String(validFrom) } : {}),
      ...(validUntil ? { validUntil: String(validUntil) } : {}),
      stale: staleAfter ? t >= parseInstant(staleAfter) : false,
      inForce: (Number.isNaN(window.fromMs) || t >= window.fromMs) && (Number.isNaN(window.untilMs) || t < window.untilMs),
      superseded: supersededBy.length > 0,
      ...(supersededBy.length > 0 ? { supersededBy } : {}),
      contested: contestedBy.length > 0,
      ...(contestedBy.length > 0 ? { contestedBy } : {}),
    },
    evidence: (Array.isArray(moca.evidence) ? moca.evidence : [])
      .map((e, i) => ({ e, matched: rep.evidenceChecks?.[i]?.matched, located: rep.evidenceChecks?.[i]?.located }))
      .filter(({ e }) => e && typeof e === 'object')
      .map(({ e, matched, located }) => ({
        source: sources.get(e.source) ?? { id: e.source },
        ...(e.selector ? { selector: e.selector } : {}),
        ...(e.note ? { note: e.note } : {}),
        ...(matched !== undefined ? { matched } : {}),
        // Contract §7: where a refined quote is spoken, cue-precise.
        ...(located ? { located: { ...located } } : {}),
      })),
    ...(rep.concepts ? { concepts: [...rep.concepts] } : {}),
    ...(audience.label !== undefined ? { audience: audience.label } : {}),
    ...(audience.invalid ? { audienceInvalid: true } : {}),
    ...(result.profiles.length > 0 ? { profiles: [...result.profiles] } : {}),
  };
  if (text !== undefined) record.text = text;
  return record;
}
