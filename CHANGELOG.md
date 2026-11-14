# Changelog

All notable changes to @openmoca/moca-core. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

For moca-spec 0.7.0 ([moca-spec#5](https://github.com/openmoca/moca-spec/issues/5)).

### Added (encrypted packages §2–§6)

- Envelopes: recognised by content in a Zip path or bytes (a `.moca.enc`
  path is sniffed as Zip); the entry and marker checks; the opening order of
  encrypted packages §5.2 through the read options `decryptor` and
  `keyProvider`; the outline check; the `envelope` result. `E001`–`E006`
  join `lib/codes.js`, and the `E` family makes a package invalid.
- `limits.maxScryptWorkFactor` (default 20).
- `bindEnvelopeSidecar()`: `index.age` through the same key provider; a
  failure makes the sidecar unusable and never changes validity.
- The moca-enc schema is bundled (`mocaEnc`).

### Added (encrypted packages §4)

- `@openmoca/moca-core/age`: decrypt-only age v1 on `node:crypto`, with no
  new dependency. X25519 and scrypt recipients, no plugins, no armor. Strict
  header parsing (64 KiB cap, canonical base64, scrypt alone, work-factor
  limit checked before scrypt runs), constant-time MAC compare, and no
  plaintext released before the whole payload authenticates. The core never
  imports it: a host passes `ageDecryptor` to enable the `encryption`
  feature. Tested against every applicable C2SP age test vector (CCTV, in
  `test/fixtures/cctv-age/`), and against the Go age CLI on moca-spec's
  envelope fixtures.

### Added (package spec §4.1)

- `distribution` in the package result: the manifest's value, or `open`
  when it has none; absent when the manifest fails its schema. It is a label
  only and changes nothing else the Reader does.

## [0.6.0] - 2026-11-11

### Added (attestations §5, §6)

- Strict Ed25519 checks before verifying (`isPrimeOrderPoint`,
  `strictEncodings`): A and R are canonical points of prime order, S < L.
- `sigstore.trustedRoot` in a trust root: Sigstore bundles are verified
  against it alone, offline, through `@sigstore/verify`. An unusable one is
  A003; a bundle that cannot be read against it is A002. The corpus's seven
  `sigstore-*` cases test it with real bundles from a self-made test
  Sigstore.

### Fixed (frontmatter line ends)

- Only LF or CRLF ends a line in the frontmatter block, in every Reader. The
  reference Reader also ended lines at a lone CR, U+2028 and U+2029.

### Fixed (edge cases)

- A stored archive entry whose bytes do not match its declared size or CRC-32
  is unreadable (P002), as a deflated one is.
- M007 knows every IANA formal URN namespace and informal ones.
- A leading byte order mark is not part of an evidence source.

### Added (versioning, package spec §14)

- `M009_MOCA_VERSION_NEWER` (warning) for a package written for a newer
  `mocaVersion` than `MOCA_VERSION` (`0.6`). Versions compare numerically, without
  overflow. The vendored schemas have portable patterns.

### Added (composition limits, package spec §7.1.1)

- Member resolution is bounded: `limits.maxMemberDepth` and `limits.maxMembers` (defaults 8 and 256, across every
  depth of one read). A member past either limit is not resolved, and
  `R001_MEMBER_UNRESOLVED` says why.

### Removed (structure.json, moca-spec ADR-0019)

- The Reader no longer reads or checks `structure.json`, and
  `O004_STRUCTURE_VIEW_MISMATCH` is retired. A package that ships the file
  stays valid and gets `structured` from `structure.ttl` alone. `structureView` stays; `STRUCTURE_VIEW_FILE` is removed.

### Changed (sidecars and search)

- A sidecar item's `text` must equal the package's bytes at its span, which
  must lie in the body (`S004`); lexical search reads the package's bytes, never
  the sidecar's text, so a sidecar cannot stuff keywords into a node.
- A prefix declared by only the index or only the embedder is `S006`.
- The gate keeps one result per node representation and span: the English and
  French pages of one node are no longer merged.

### Changed (determinism)

- `moca.json` and attestation statements that repeat a member name are `M001`
  and `A001` (they were read with the last value).
- Locale fallback: exact, then the longest tag the request starts with, then the
  lowest tag starting with the request, all case-insensitive.
- Evidence: Markdown and HTML quotes are normalised like their sources, and a
  `TextPositionSelector` on its own is no longer checked (`matched` absent).

### Changed (limits and archives, review B9 and M6)

- Evidence work is bounded per package (`maxEvidenceChecksPerPackage`, 10,000;
  `maxEvidenceBytesPerPackage`, 256 MiB scanned), each source is normalised once,
  and a quote is matched in one pass. A package of 200 nodes with 256 quotes each
  against an 8 MiB source now reads in well under a second.
- Directories have the entry and byte limits, and a file replaced by a link
  after listing is unreadable.
- Archives: names must be UTF-8 (flag set) with no NUL, empty or `.` segments;
  duplicate entries are `P003` (they made `readPackage` throw); only stored and deflated entries are read
  (others `P002`), and an unreadable entry stops the read.

### Changed (identity and tampering, review M2 and M3)

- A library refuses a second package with the same `id@version` and a different
  digest, and reports `L001_IDENTITY_CONFLICT` (it was dropped silently).
- A package attestation naming this `id@version` with another digest is
  `A008_PACKAGE_DIGEST_MISMATCH`, not `A002`.
- A resolved member whose `id` or `version` differs from its pin is `R002`.
- `readPackage(target, { requireSignature: true })` makes a package without a valid package attestation invalid
  (`A009_SIGNATURE_REQUIRED`).

### Changed (store search, review B2)

- A store search takes the loaded packages' states (`packageState(result)`; `new Search({ packages, clock }, …)`) instead of bare
  digests, and recomputes `superseded`, `contested`, `signed`, `signers`,
  `attestedReviews` and `reviewStatus` at query time (contract §9.4). A package
  superseded after ingest, or a key removed from the trust root, is reflected
  at once.

### Changed (reviews, moca-spec ADR-0017)

- `reviewed` needs a signed package with every reviewed file approved.
  Citation records gain `trust.reviewStatus` (`approved`, `disputed`,
  `unverified`, `none`) and each review's `packageVerified`. The latest review
  from each signer counts; a review dated after the clock is ignored
  (`A007_REVIEW_DATE_FUTURE`); a trust-root entry's `reviewers` list limits whom
  its key may sign as.

### Changed (audience, moca-spec ADR-0016)

- Under a host audience set, content with no audience label is left out unless
  the host allows it (`new Search(source, { audiences, allowUnlabelled: true })`, off by default), and a malformed label never
  matches; citation records mark it `audienceInvalid`. A translation with no
  label has its default representation's. The gate, the backends and the store
  backend apply the same rule.

### Changed (relations, moca-spec ADR-0015)

- `supersedes` and `conflictsWith` take effect only when the declaring package
  has a valid package attestation from a key or Sigstore identity whose new
  trust-root `ids` cover the target's id (package spec §7.2). Otherwise the
  Reader reports `R004_RELATION_UNAUTHORISED` (info) and the relation has no
  effect. `new Library({ allowUnsignedRelations: true })` (off by default) applies unsigned relations, for a library
  of the host's own packages.

### Changed

Dates follow package spec §4.4:

- A full date means 00:00Z; a date-time needs an offset, and one without is
  ignored (it already has a diagnostic) rather than read as local time.
- A node's validity window is the intersection with its package's: a node can
  no longer stay in force after the package's `validUntil`. An inverted window
  is ignored.
- A trust-root key is not trusted from the instant of `expires`, checked
  against the host clock, which `readPackage` now takes (`clock`, a function returning a `Date`). A key whose `expires`
  does not parse is not trusted.

Attestation verification follows the numbered algorithm now in attestations §7
(0.6.0):

- DSSE payloads and signatures are decoded strictly: base64 or base64url, with
  or without padding. Anything else makes the payload malformed (`A001`) or the
  signature not verify.
- Sigstore: a trust root that lists identities, but none for the attestation's
  role, makes it invalid (`A002`) rather than unverifiable (`A003`).
- A trust root is refused if it repeats a `keyid` or has a key or identity
  without `roles`. An empty `roles` list trusts the entry for nothing.

### Fixed

Fixes from the 10 November 2026 specification review, each with a new case
in the moca-spec 0.6.0 conformance corpus:

- A malformed percent-encoding in a source `resource` or a link is reported as
  `C008_UNSAFE_PATH` instead of throwing `URIError` out of `readPackage`.
- An absolute reference (a leading `/` or `\`, or a drive prefix such as `C:/`)
  is `C008_UNSAFE_PATH`, as the Reader contract says. It was resolved under
  `content/`.
- Structure traversal is iterative: a 30,000-concept `requires` chain no longer
  overflows the call stack.
- A validity bound or `stale_after` that does not parse as a date is treated as
  absent; it no longer takes a node out of force.
- A `generated` or `verified` entry with no `by` is dropped; it was reported
  with the actor `"undefined"`.
- `log.md` and `index.md` frontmatter gets the frontmatter size limit, and a
  level-two heading (`##`) inside a fenced code block in `log.md` is no longer a C004 error.
- `moca.json` that is not valid UTF-8 is `M001`; it was read with replacement
  characters.
- Only entries under `attestations/` are left out of the digest; a top-level
  file named `attestations` is digested.
- Member cycles are detected by `id@version`, so a package can compose another
  version of itself.
- A host source's byte limit is also enforced on the bytes it returns, and a
  limit broken while reading is one `T003`, not a `P002` per file. An existing
  file that is not a directory or a `.moca`/`.zip` archive is `T002`.
- Archive bytes (a `Buffer` or `Uint8Array`) are accepted as a target.
- Sigstore verification is offline by default: without `online`, trust material
  comes from the TUF cache and is never refreshed over the network; if it is
  unavailable the attestation is unverifiable (`A003`), not invalid.

## [0.5.0] - Not published

### Performance

- **Lexical search keeps each document's term counts** after its first search,
  per package digest, and drops them when the package leaves the library.
  Later searches only score: at 5,000 pages, about 7 ms a search instead of
  about 2 s. Scores and order are unchanged (the corpus, and the .NET and
  Python Readers' parity checks against this Reader, pass). `bm25()` is
  unchanged; `countTerms()` and `bm25Counted()` are new.
### Changed

- DSSE attestations use Ed25519 keys only, as attestations §5 now requires.
  `createEnvelope` refuses any other key type, and a trusted key of another
  type verifies nothing: the attestation is invalid (`A002`). Before, ECDSA
  and RSA signatures verified here and in the .NET Reader, but not in the
  Python Reader.
- The Reader runs where there is no file system, such as a Cloudflare Worker or
  a browser bundle. Its JSON Schemas are imported as JSON modules instead of
  read from disk when it loads. Ajv still compiles the validators when the
  module loads: Workers allow code generation then, not during a request.

### Fixed

- Archive entries are inflated by the Reader with `node:zlib`, capped at the
  declared size and checked against it and the CRC-32. In Cloudflare Workers
  the zip library's exact cap failed for some entry sizes ("Memory limit
  exceeded"; about 45 KB to 128 KB), so valid packages were reported as
  unreadable. Node is unaffected.
- An entry that cannot be read (`P002_UNREADABLE_ENTRY`), for example in an
  archive whose sizes lie, now ends the read with that diagnostic. Before, the
  Reader read on with the bytes missing and threw a `TypeError`.

## [0.4.0-alpha.2] - 2026-10-30

The first release from this repository. It was previously part of moca-spec at 0.4.0-alpha.1.

### Added

- `HybridBackend`: a lexical and a dense backend merged by Reciprocal Rank
  Fusion (moca-spec#15). k (default 60) and per-backend weights (default 1)
  are the host's. Packages the dense side cannot search (`S006`, `S007`)
  come back through the lexical side.
- Embedding roles (moca-spec#12): the Reader calls `embed(texts, { role })`
  with `query` for a search and `document` when the in-memory store ingests.
  An embedder may declare `queryPrefix` and `documentPrefix`; they are
  compared with an index's like `version` (`S006` on a difference), never
  applied.
- Dense search scores by the index's `model.distance`: cosine (the default),
  `dot` or `euclidean` (negative distance, so higher is better); it was
  always cosine (moca-spec#10). `MemoryStoreBackend` takes a `distance`
  option. `similarity()` is exported.
- `diversify({ perNode })`: an opt-in egress strategy that brings each
  node's best results forward, so one node's chunks don't fill the list. With
  any egress hook, `Search` now fetches more than the limit from every
  backend, so the hook has candidates to choose from.
- `S007_NO_VECTORS`: a dense backend reports each loaded package it has no
  vectors for, which it does not search. Such packages were skipped silently
  (Reader contract §9.3).

### Fixed

- Path collisions (`P003`) lower-case paths with the simple mapping per code
  point, as package spec §6.3 now says (`lib/unicode.js`, shared with the
  tokeniser): `İ.md` and `i.md` collide, and `İ.md` and `i̇.md` no longer do.
- Lexical search tokenises text in any script: NFKC, combining marks kept
  inside words, and Chinese, Japanese, Thai, Lao, Khmer and Myanmar split into
  characters and character pairs. Without a locale it searches every language
  of a node, not only the default. The rules are in the README; the
  `token-vectors.json` test strings are shared with the other Reader.
- Sidecar items without `text` (it is optional) are searched by the package
  text their offsets point at. The lexical and in-memory store backends used
  an empty string, so only node titles matched (Reader contract §9.1).
- A retrieval hook can no longer widen what search returns (Reader contract
  §9.2). An ingress hook's `includeAll`, `limit` and `locale` were merged into
  the request the gate read, so a hook could return superseded, expired and
  deprecated content. Ingress may now change only the query, concepts and
  scope, the gate follows the caller, and hooks see the request read-only.

### Changed

- A Markdown link written with its destination in angle brackets
  (`[PDF](<https://…>)`) is no longer reported as an unresolved package path
  (`C007_LINK_UNRESOLVED`).
- `npm run check:schemas` checks that `lib/schemas/` matches moca-spec's
  `schemas/v1/`. It runs with `npm test`.
