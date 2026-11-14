// Diagnostic codes. This table mirrors spec/moca-reader-contract.md §11, which
// is normative: codes are the contract, message prose is not. A change here
// without the matching spec change is a bug.

export const SEVERITY = Object.freeze({ ERROR: 'error', WARNING: 'warning', INFO: 'info' });

const E = SEVERITY.ERROR;
const W = SEVERITY.WARNING;
const I = SEVERITY.INFO;

export const CODES = Object.freeze({
  // Target
  T001_TARGET_NOT_FOUND: { severity: E, summary: 'The target does not exist.' },
  T002_MANIFEST_NOT_FOUND: { severity: E, summary: 'The target exists but has no moca.json at its root.' },
  T003_ARCHIVE_REJECTED: { severity: E, summary: 'An archive or host source broke a safety rule or limit.' },

  // Package entries and the canonical digest
  P001_UNSUPPORTED_ENTRY: { severity: E, summary: 'The package contains a symbolic link or other non-regular file.' },
  P002_UNREADABLE_ENTRY: { severity: E, summary: 'A package entry could not be read.' },
  P003_PATH_COLLISION: { severity: E, summary: 'Two package paths are equal after Unicode NFC normalisation or case folding.' },

  // Manifest
  M001_MANIFEST_INVALID_JSON: { severity: E, summary: 'moca.json is not valid UTF-8 JSON.' },
  M002_MANIFEST_SCHEMA: { severity: E, summary: 'moca.json does not validate against the manifest schema.' },
  M003_NO_CONTENT: { severity: E, summary: 'The package has neither a content node nor a member.' },
  M004_UNKNOWN_KEY: { severity: I, summary: 'A top-level manifest key is neither defined by the spec nor a vendor x-<vendor>-<key> key.' },
  M005_DUPLICATE_MEMBER: { severity: E, summary: 'The same member id appears more than once.' },
  M006_VALIDITY_WINDOW_INVALID: { severity: W, summary: 'validUntil is not later than validFrom.' },
  M007_UNREGISTERED_URN: { severity: I, summary: 'The package id uses a URN namespace that is not registered with IANA.' },
  M008_DIGEST_V1_PACKAGE: { severity: I, summary: 'The package was written for a mocaVersion before 0.4; digests, pins and attestations made then will not match moca-digest-v2.' },
  M009_MOCA_VERSION_NEWER: { severity: W, summary: 'The package was written for a newer mocaVersion than this Reader implements; it is read on a best-effort basis.' },

  // Content (OKF bundle rules plus MOCA extensions)
  C001_FRONTMATTER_MISSING: { severity: E, summary: 'A concept document has no YAML frontmatter (OKF MUST).' },
  C002_FRONTMATTER_INVALID: { severity: E, summary: 'Frontmatter is not parseable YAML or is not a mapping.' },
  C003_TYPE_MISSING: { severity: E, summary: 'Frontmatter has no non-empty type (OKF MUST).' },
  C004_RESERVED_FILE_INVALID: { severity: E, summary: 'index.md or log.md breaks the OKF reserved-file rules.' },
  C005_FIELD_INVALID: { severity: W, summary: 'A frontmatter field does not match the node schema.' },
  C006_EVIDENCE_SOURCE_UNKNOWN: { severity: W, summary: 'moca.evidence names a source id that sources[] does not declare.' },
  C007_LINK_UNRESOLVED: { severity: W, summary: 'An internal Markdown link does not resolve.' },
  C008_UNSAFE_PATH: { severity: E, summary: 'A package-relative path is absolute or escapes the package root.' },
  C009_LOCALE_ORPHAN: { severity: W, summary: 'A locale variant has no default-language file.' },
  C010_VALIDITY_WINDOW_INVALID: { severity: W, summary: 'moca.valid_until is not later than moca.valid_from.' },
  C011_EVIDENCE_SELECTOR_UNMATCHED: { severity: W, summary: 'An evidence selector does not match the text source file it cites inside the package.' },

  // Encrypted packages (moca-encrypted-package.md)
  E001_ENCRYPTED_NO_KEY: { severity: E, summary: 'An envelope was not opened: no key provider, no key or a kind of key no stanza uses, or no encryption feature.' },
  E002_DECRYPTION_FAILED: { severity: E, summary: 'A key was supplied for an envelope, but unwrapping or the header MAC failed.' },
  E003_PAYLOAD_CORRUPT: { severity: E, summary: "An envelope's encrypted payload failed authentication or was truncated." },
  E004_OUTLINE_MISMATCH: { severity: E, summary: "An envelope's outline differs from the decrypted manifest or structure." },
  E005_ENVELOPE_INVALID: { severity: E, summary: 'An envelope has a missing, repeated or unexpected entry, an encrypted entry that is not stored, or an invalid moca-enc.json.' },
  E006_AGE_HEADER_INVALID: { severity: E, summary: "An envelope's age header is malformed or unsupported, over 64 KiB, or breaks the scrypt rules or limit." },

  // Attestations
  A001_ATTESTATION_MALFORMED: { severity: E, summary: 'An attestation file is not a parseable envelope and statement.' },
  A002_ATTESTATION_INVALID: { severity: E, summary: 'An attestation failed verification or does not match the package.' },
  A003_ATTESTATION_UNVERIFIABLE: { severity: W, summary: 'An attestation could not be checked because no trust root was supplied.' },
  A004_ATTESTATION_INDETERMINATE: { severity: W, summary: 'Online verification was requested but could not complete.' },
  A006_REVIEW_OUTDATED: { severity: W, summary: 'A review attestation covers a file whose bytes have since changed or been removed.' },
  A007_REVIEW_DATE_FUTURE: { severity: W, summary: 'A review is dated later than the host clock, so it does not count.' },
  A008_PACKAGE_DIGEST_MISMATCH: { severity: E, summary: 'A package attestation names this id and version with a different digest: the content changed after it was signed.' },
  A009_SIGNATURE_REQUIRED: { severity: E, summary: 'The host requires a valid package attestation and the package has none.' },

  // Members (composition)
  R001_MEMBER_UNRESOLVED: { severity: W, summary: 'A member could not be resolved by the host resolver.' },
  R002_MEMBER_DIGEST_MISMATCH: { severity: E, summary: 'A resolved member does not match its pinned digest.' },
  R003_MEMBER_CYCLE: { severity: E, summary: 'Members form a cycle.' },
  L001_IDENTITY_CONFLICT: { severity: E, summary: 'A library was given a second package with the same id and version but a different digest; the second is refused.' },
  R004_RELATION_UNAUTHORISED: { severity: I, summary: 'A supersedes or conflictsWith relation is not authorised by a signer of the package, so it has no effect.' },

  // Profiles
  F001_PROFILE_UNRECOGNISED: { severity: I, summary: 'A declared profile is not recognised by this reader.' },

  O001_ONTOLOGY_UNPARSEABLE: { severity: W, summary: 'A structure or overlay file is over the size or triple limit, or is not parseable Turtle.' },
  O002_CONCEPT_UNDECLARED: { severity: W, summary: 'A concept is used in a relation or node binding but not declared as a skos:Concept.' },
  O003_REMOTE_REFERENCE: { severity: W, summary: 'An ontology file or concept binding relies on something a Reader would have to fetch or resolve.' },
  O005_STRUCTURE_CYCLE: { severity: W, summary: 'requires, broader or hasPart forms a cycle.' },

  // Sidecar indexes
  S001_SIDECAR_INVALID: { severity: E, summary: 'index.json does not validate against the sidecar schema.' },
  S002_SIDECAR_TARGET_MISMATCH: { severity: E, summary: 'The sidecar is bound to a different package id or version.' },
  S003_SIDECAR_STALE: { severity: W, summary: 'The sidecar digest does not match the package; the sidecar is ignored.' },
  S004_SIDECAR_ITEM_INVALID: { severity: E, summary: 'A payload item breaks the addressing rules.' },
  S005_SIDECAR_FORMAT_UNKNOWN: { severity: I, summary: 'The payload format is not recognised; the sidecar is ignored.' },
  S006_MODEL_MISMATCH: { severity: W, summary: "The host's embedder does not match the index's model; dense search is refused." },
  S007_NO_VECTORS: { severity: W, summary: 'A loaded package has no vectors a dense backend can search; that package is not searched.' },
});

/** @param {string} code */
/** Codes that are no longer emitted. Codes are never reused (spec/moca-reader-contract.md). */
export const RETIRED_CODES = Object.freeze(['A005_SKILLS_WITHHELD', 'K001_SKILL_INVALID', 'O004_STRUCTURE_VIEW_MISMATCH']);

export function defaultSeverity(code) {
  const entry = CODES[code];
  if (!entry) throw new Error(`unknown diagnostic code ${code}`);
  return entry.severity;
}
