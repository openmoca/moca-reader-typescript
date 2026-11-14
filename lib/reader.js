// The reference Reader: spec/moca-reader-contract.md.
//
// readPackage() opens a package from any source, checks it, computes its
// digest, verifies its attestations against a host trust root, resolves
// members through a host resolver, and returns everything an application
// needs. It never executes package content, never performs network I/O of
// its own, and never acts on a location or setting a package supplies.
import { duplicateKey } from './json-strict.js';
import { reviewStatusOf } from './reviews.js';
import { parseInstant } from './dates.js';
import { checkCatalogue, checkManifest } from './manifest.js';
import { readContent } from './content.js';
import { Diagnostics } from './diagnostics.js';
import { openSource, TargetError, DEFAULT_LIMITS } from './source.js';
import { packageFiles, computeDigest, MANIFEST, ATTESTATIONS_DIR } from './digest.js';
import {
  loadTrustRoot, parseAttestation, verifySignature, checkPackageStatement, checkReviewStatement, scopeCovers,
  PREDICATE_PACKAGE, PREDICATE_REVIEW,
} from './attestations.js';
import { KNOWN_PROFILES } from './profiles.js';
import { readStructure } from './structure.js';
import { isEnvelope, readEnvelope, outlineMismatch } from './envelope.js';

// A009 invalidates: it is only raised when the host requires a signature. Contract §11: so does the E family.
const INVALIDATING = /^((T|P|M|C|E)\d|A009)/;

/**
 * @typedef {object} ReadOptions
 * @property {string|object} [trustRoot]  path, trust-root document, or loadTrustRoot() result
 * @property {(member: { id: string, version: string, digest: string }) => (string|object|null|Promise<string|object|null>)} [resolveMember]
 *   host resolver returning a target (path or source) for a member, or null
 * @property {boolean} [strict]  promote warnings to errors
 * @property {Partial<typeof DEFAULT_LIMITS>} [limits]  see DEFAULT_LIMITS in source.js
 * @property {Iterable<string>} [knownProfiles]
 * @property {boolean} [online]  opt in to online Sigstore verification
 * @property {boolean} [allowOfflineFallback]
 * @property {string} [tufCachePath]
 * @property {(request: { stanzas: { type: string, args: string[], body: Uint8Array }[], outline?: object, file: 'package'|'index' }) =>
 *   ({ identities: string[] } | { passphrase: string } | { fileKey: Uint8Array } | null | undefined
 *   | Promise<{ identities: string[] } | { passphrase: string } | { fileKey: Uint8Array } | null | undefined>)} [keyProvider]
 *   encrypted packages §5.1: supplies keys to open an envelope
 * @property {{ parseHeader: Function, decrypt: Function }} [decryptor]  `ageDecryptor` from `@openmoca/moca-core/age`:
 *   enables the optional feature `encryption`. Without it, an envelope is reported with E001.
 */

/**
 * @param {string|object} target  directory, .moca/.zip path, or host source
 * @param {ReadOptions} [options]
 */
export async function readPackage(target, options = {}) {
  return readInternal(target, options, [], { resolved: 0 });
}

/** The specification version this Reader implements, `major.minor` (package spec §14). */
export const MOCA_VERSION = '0.6';

/** Compares a matched `major.minor` with a version string, numerically and without overflow. */
function compareVersion(declared, version) {
  const [major, minor] = version.split('.');
  const num = (a, b) => {
    const x = a.replace(/^0+(?=\d)/, '');
    const y = b.replace(/^0+(?=\d)/, '');
    return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
  };
  return num(declared[1], major) || num(declared[2], minor);
}

/**
 * @param {{ outline?: object, structure?: Uint8Array }} [envelopeCheck]  set only when reading an envelope's inner
 *   archive: the outline to check right after the manifest is parsed (encrypted packages §5.2 step 8)
 */
async function readInternal(target, options, stack, budget, envelopeCheck) {
  const diagnostics = new Diagnostics({ strict: options.strict });
  const result = {
    manifest: null,
    digest: null,
    nodes: [],
    fileDigests: new Map(),
    attestations: [],
    reviewsByFile: new Map(),
    signers: [],
    // Package spec §7.2: the package ids its valid package attestations' signers may speak for.
    relationScopes: [],
    members: [],
    profiles: [],
    diagnostics: diagnostics.items,
    valid: false,
    capabilities: [],
    payloadManifest: null,
    structure: null,
    source: null,
  };

  let source;
  try {
    source = openSource(target, options.limits);
    source.list();
  } catch (err) {
    if (err instanceof TargetError) {
      diagnostics.add(err.code, err.message);
      return result;
    }
    throw err;
  }
  result.source = source;

  const { ok: entriesOk, files } = packageFiles(source, diagnostics);
  // Encrypted packages §2: an archive with moca-enc.json at its root is an envelope (never the inner archive).
  if (!envelopeCheck && isEnvelope(source, files)) {
    return readEnvelope({
      source, files, entriesOk, diagnostics, options, result, finish,
      readInner: (bytes, check) => readInternal(bytes, options, stack, budget, check),
    });
  }
  if (!files.has(MANIFEST)) {
    diagnostics.add('T002_MANIFEST_NOT_FOUND', 'the target has no moca.json at its root');
    return finish(result, diagnostics);
  }

  const bytes = new Map();
  let readable = true;
  for (const [nfc, stored] of files) {
    try {
      bytes.set(nfc, source.read(stored));
    } catch (err) {
      // A limit broken while reading rejects the whole source (T003), once.
      if (err instanceof TargetError) {
        diagnostics.add(err.code, err.message);
        return result;
      }
      diagnostics.add('P002_UNREADABLE_ENTRY', `"${stored}" could not be read: ${err.message}`, { file: stored });
      readable = false;
    }
  }
  // An entry that cannot be read (a damaged archive, or one whose sizes lie) leaves nothing to check the rest
  // against: stop with P002 rather than read on with missing bytes.
  if (!readable) return finish(result, diagnostics);

  let manifest;
  try {
    // Contract §11, M001: moca.json is UTF-8; invalid bytes are an error, not replaced.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.get(MANIFEST));
    manifest = JSON.parse(text.replace(/^﻿/, ''));
    // I-JSON (RFC 7493): a repeated member name would let Readers disagree on `id`.
    const repeated = duplicateKey(text);
    if (repeated !== null) throw new Error(`member "${repeated}" appears more than once`);
  } catch (err) {
    diagnostics.add('M001_MANIFEST_INVALID_JSON', `moca.json is not valid UTF-8 JSON: ${err.message}`, { file: MANIFEST });
    return finish(result, diagnostics);
  }
  result.manifest = manifest;
  if (envelopeCheck) {
    const why = outlineMismatch(envelopeCheck, manifest, bytes, { ...DEFAULT_LIMITS, ...options.limits });
    if (why) {
      diagnostics.add('E004_OUTLINE_MISMATCH', why, { file: MANIFEST });
      return finish(result, diagnostics);
    }
  }
  checkManifest(manifest, diagnostics, { knownProfiles: options.knownProfiles ?? KNOWN_PROFILES });
  // Package spec §4.1: the publisher's intent, exposed and never acted on. Absent when the manifest fails its schema.
  if (!diagnostics.items.some((d) => d.code === 'M002_MANIFEST_SCHEMA')) {
    result.distribution = manifest.distribution ?? 'open';
    // Package spec §4.9: advice, exposed as declared and never fetched, resolved or opened.
    if (Array.isArray(manifest.apps)) result.apps = [...manifest.apps];
    // Package spec §4.6–4.8: kept aside, and exposed by finish() only when the package is valid.
    catalogue.set(result, checkCatalogue(manifest, bytes, diagnostics, { ...DEFAULT_LIMITS, ...options.limits }));
  }
  result.profiles = Object.keys(manifest?.profiles ?? {});
  // Package spec §14: M008 only for a declared mocaVersion below 0.4; M009 for one newer than this Reader's.
  const declared = /^(\d+)\.(\d+)$/.exec(String(manifest?.mocaVersion ?? ''));
  if (declared && compareVersion(declared, '0.4') < 0) {
    diagnostics.add('M008_DIGEST_V1_PACKAGE', `written for mocaVersion ${manifest.mocaVersion}; its digest is now computed with moca-digest-v2, so pins and attestations made under 0.3 or earlier will not match`, { file: MANIFEST });
  }
  if (declared && compareVersion(declared, MOCA_VERSION) > 0) {
    diagnostics.add('M009_MOCA_VERSION_NEWER', `written for mocaVersion ${manifest.mocaVersion}, newer than ${MOCA_VERSION}; read on a best-effort basis`, { file: MANIFEST });
  }

  if (entriesOk && readable) {
    const { digest, fileDigests, manifest: payloadManifest } = computeDigest(source, files, (stored) => bytes.get(stored.normalize('NFC')));
    result.digest = digest;
    result.fileDigests = fileDigests;
    result.payloadManifest = payloadManifest;
  }

  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  result.nodes = readContent({ manifest, files, bytes, fileDigests: result.fileDigests, diagnostics, limits });
  result.structure = readStructure({ bytes, nodes: result.nodes, diagnostics, limits, origin: result.digest });
  const members = Array.isArray(manifest?.members) ? manifest.members : [];
  if (result.nodes.length === 0 && members.length === 0) {
    diagnostics.add('M003_NO_CONTENT', 'a package needs at least one content node under content/ or at least one member');
  }

  const trustRoot = options.trustRoot === undefined ? undefined
    : typeof options.trustRoot.key === 'function' ? options.trustRoot : loadTrustRoot(options.trustRoot);
  if (result.digest) await readAttestations(result, bytes, trustRoot, options, diagnostics);

  // Attestations §8: a host can require a valid package attestation.
  if (options.requireSignature && result.signers.length === 0) {
    diagnostics.add('A009_SIGNATURE_REQUIRED', 'the host requires a valid package attestation, and this package has none', { file: MANIFEST });
  }
  checkRelationAuthority(result, diagnostics);
  await resolveMembers(result, members, options, stack, diagnostics, budget);
  return finish(result, diagnostics);
}

async function readAttestations(result, bytes, trustRoot, options, diagnostics) {
  const { manifest, digest } = result;
  const files = [...bytes.keys()].filter((p) => p.startsWith(`${ATTESTATIONS_DIR}/`) && /\.(dsse|sigstore)\.json$/.test(p)).sort();
  for (const file of files) {
    const parsed = parseAttestation(file, bytes.get(file));
    if (!parsed.ok) {
      diagnostics.add('A001_ATTESTATION_MALFORMED', parsed.reason, { file });
      result.attestations.push({ file, outcome: 'malformed', reason: parsed.reason });
      continue;
    }
    const type = parsed.statement.predicateType;
    if (type !== PREDICATE_PACKAGE && type !== PREDICATE_REVIEW) {
      result.attestations.push({ file, predicateType: type, outcome: 'ignored', reason: 'unknown predicate type' });
      continue;
    }
    const role = type === PREDICATE_PACKAGE ? 'package' : 'review';
    const sig = await verifySignature(parsed, trustRoot, role, options);
    const record = { file, predicateType: type, role, format: parsed.format, outcome: sig.outcome, signer: sig.signer, reason: sig.reason };
    result.attestations.push(record);
    if (sig.outcome === 'unverifiable') {
      diagnostics.add('A003_ATTESTATION_UNVERIFIABLE', `${role} attestation not checked: ${sig.reason}`, { file });
      continue;
    }
    if (sig.outcome === 'indeterminate') {
      diagnostics.add('A004_ATTESTATION_INDETERMINATE', sig.reason, { file });
      continue;
    }
    if (sig.outcome === 'invalid') {
      diagnostics.add('A002_ATTESTATION_INVALID', `${role} attestation signature did not verify: ${sig.reason}`, { file });
      continue;
    }

    if (role === 'package') {
      const mismatch = checkPackageStatement(parsed.statement, { id: manifest.id, version: manifest.version, digest });
      if (mismatch) {
        record.outcome = 'invalid';
        record.reason = mismatch;
        // Attestations §3: a statement naming this id@version with another digest is
        // positive evidence that the content changed after signing.
        const subject = parsed.statement.subject?.[0];
        const tampered = parsed.statement.subject?.length === 1 && subject?.name === `${manifest.id}@${manifest.version}`;
        diagnostics.add(tampered ? 'A008_PACKAGE_DIGEST_MISMATCH' : 'A002_ATTESTATION_INVALID', `package attestation does not match this package: ${mismatch}`, { file });
      } else {
        result.signers.push(sig.signer);
        result.relationScopes.push(...(sig.ids ?? []));
      }
      continue;
    }

    const review = checkReviewStatement(parsed.statement, manifest.id, result.fileDigests);
    if (review.error) {
      record.outcome = 'invalid';
      record.reason = review.error;
      diagnostics.add('A002_ATTESTATION_INVALID', review.error, { file });
      continue;
    }
    // Attestations §4: a key or identity with a `reviewers` list may only sign as those reviewers.
    if (sig.reviewers && !sig.reviewers.includes(review.predicate.reviewer)) {
      record.outcome = 'invalid';
      record.reason = `the signing key may not sign as reviewer ${review.predicate.reviewer}`;
      diagnostics.add('A002_ATTESTATION_INVALID', record.reason, { file });
      continue;
    }
    // A review dated after the host clock does not count.
    const now = options.clock ? options.clock() : (options.now ?? new Date());
    if (parseInstant(review.predicate.reviewedAt) > now.getTime()) {
      record.outcome = 'ignored';
      record.reason = `review is dated ${review.predicate.reviewedAt}, later than now`;
      diagnostics.add('A007_REVIEW_DATE_FUTURE', record.reason, { file });
      continue;
    }
    record.current = review.current;
    record.outdated = review.outdated;
    for (const path of review.outdated) {
      diagnostics.add('A006_REVIEW_OUTDATED', `review of ${path} no longer matches the file`, { file });
    }
    for (const path of review.current) {
      const entry = {
        reviewer: review.predicate.reviewer,
        reviewedAt: review.predicate.reviewedAt,
        outcome: review.predicate.outcome,
        signer: sig.signer,
        ...(review.predicate.scope ? { scope: review.predicate.scope } : {}),
      };
      const key = path.normalize('NFC');
      if (!result.reviewsByFile.has(key)) result.reviewsByFile.set(key, []);
      result.reviewsByFile.get(key).push(entry);
    }
  }
  // Attestations §4: for each file, the latest review from each signer counts.
  for (const [file, entries] of result.reviewsByFile) {
    const latest = new Map();
    for (const e of entries) {
      const prev = latest.get(e.signer);
      if (!prev || parseInstant(e.reviewedAt) >= parseInstant(prev.reviewedAt)) latest.set(e.signer, e);
    }
    result.reviewsByFile.set(file, [...latest.values()]);
  }
}

/**
 * Package spec §7.2: a supersedes or conflictsWith relation takes effect only
 * when a signer of this package may speak for the target id. Otherwise it is
 * reported (R004, info) and has no effect unless the host allows unsigned
 * relations.
 */
function checkRelationAuthority(result, diagnostics) {
  const relations = Array.isArray(result.manifest?.relations) ? result.manifest.relations : [];
  for (const r of relations) {
    if (!['supersedes', 'conflictsWith'].includes(r?.type) || typeof r.target !== 'string') continue;
    if (!scopeCovers(result.relationScopes, r.target)) {
      diagnostics.add('R004_RELATION_UNAUTHORISED', `${r.type} ${r.target} is not authorised by a signer of this package, so it has no effect`, { file: MANIFEST });
    }
  }
}

async function resolveMembers(result, members, options, stack, diagnostics, budget) {
  const { maxMemberDepth, maxMembers } = { ...DEFAULT_LIMITS, ...options.limits };
  // Cycles are detected by id@version: composing another version of the same
  // package is not a cycle.
  const id = result.manifest?.id;
  const self = `${id}@${result.manifest?.version}`;
  for (const member of members) {
    if (!member?.id || !member?.digest) continue;
    const entry = { id: member.id, version: member.version, digest: member.digest, status: 'unresolved', result: null };
    result.members.push(entry);
    if (!options.resolveMember) continue;
    const memberKey = `${member.id}@${member.version}`;
    if (memberKey === self || stack.includes(memberKey)) {
      diagnostics.add('R003_MEMBER_CYCLE', `members form a cycle: ${[...stack, self, memberKey].join(' -> ')}`, { file: MANIFEST });
      entry.status = 'cycle';
      continue;
    }
    // Package spec §7.1: depth and the members resolved per read are bounded; a member past either limit is not used.
    if (stack.length + 1 > maxMemberDepth) {
      diagnostics.add('R001_MEMBER_UNRESOLVED', `member ${memberKey} is not resolved: composition is deeper than ${maxMemberDepth} levels`, { file: MANIFEST });
      continue;
    }
    if (budget.resolved >= maxMembers) {
      diagnostics.add('R001_MEMBER_UNRESOLVED', `member ${memberKey} is not resolved: more than ${maxMembers} members in one read`, { file: MANIFEST });
      continue;
    }
    budget.resolved += 1;
    const target = await options.resolveMember({ id: member.id, version: member.version, digest: member.digest });
    if (!target) {
      diagnostics.add('R001_MEMBER_UNRESOLVED', `member ${member.id}@${member.version} could not be resolved`, { file: MANIFEST });
      continue;
    }
    const child = await readInternal(target, options, [...stack, self], budget);
    entry.result = child;
    if (child.diagnostics.some((d) => d.code === 'R003_MEMBER_CYCLE')) {
      diagnostics.add('R003_MEMBER_CYCLE', `member ${member.id} is part of a cycle`, { file: MANIFEST });
      entry.status = 'cycle';
    } else if (child.manifest && (child.manifest.id !== member.id || (member.version && child.manifest.version !== member.version))) {
      // Package spec §7.1: the resolved member must be the package the pin names.
      diagnostics.add('R002_MEMBER_DIGEST_MISMATCH', `member pinned as ${member.id}@${member.version} resolved to ${child.manifest.id}@${child.manifest.version}`, { file: MANIFEST });
      entry.status = 'mismatch';
    } else if (child.digest !== member.digest) {
      diagnostics.add('R002_MEMBER_DIGEST_MISMATCH', `member ${member.id}@${member.version} has digest ${child.digest ?? '(none)'}, but ${member.digest} is pinned`, { file: MANIFEST });
      entry.status = 'mismatch';
    } else {
      entry.status = 'resolved';
    }
  }
}

/** Images, translations and tags of a result, until finish() knows whether the package is valid. */
const catalogue = new WeakMap();

function finish(result, diagnostics) {
  result.valid = !diagnostics.items.some((d) => d.severity === 'error' && INVALIDATING.test(d.code));
  if (!result.valid) return result;
  for (const [field, value] of Object.entries(catalogue.get(result) ?? {})) result[field] = value;
  const caps = new Set(['core']);
  let allEvidenceLocal = true;
  let reviewedFiles = 0;
  let allApproved = true;
  for (const node of result.nodes) {
    for (const rep of node.representations) {
      if (Array.isArray(rep.frontmatter.moca?.evidence) && rep.frontmatter.moca.evidence.length > 0) caps.add('located-evidence');
      if (rep.evidenceChecks?.some((c) => !c.local)) allEvidenceLocal = false;
      if (rep.locale) caps.add('localized');
      if (result.reviewsByFile.has(rep.file)) {
        reviewedFiles += 1;
        if (reviewStatusOf(result.reviewsByFile.get(rep.file), result.signers.length > 0) !== 'approved') allApproved = false;
      }
    }
  }
  if (caps.has('located-evidence') && allEvidenceLocal) caps.add('self-contained-evidence');
  if (result.structure?.ok) caps.add('structured');
  if (result.members.length > 0) caps.add('composed');
  if (result.signers.length > 0) caps.add('signed');
  // Package spec §11 (moca-spec ADR-0017): signed, and every reviewed file approved.
  if (caps.has('signed') && reviewedFiles > 0 && allApproved) caps.add('reviewed');
  result.capabilities = [...caps].sort();
  return result;
}
