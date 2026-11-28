# Changelog

All notable changes to @openmoca/moca-core. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased: 0.8.0

For moca-spec 0.8.0: content in more than one language, and store states.

### Changed (store states)

- A store search takes `allow`, the digests the host has loaded, when it could not get every package's state. A
  loaded package with no state is missing (Reader contract §9.4): this Reader keeps no index of the store, so it
  withholds every record rather than return one as if that package did not limit it, and reports
  `S011_STATE_MISSING` (warning). Without `allow`, nothing changes.

### Changed

- **The locale lookup** (package spec §5.4): the default representation is tagged with the manifest's `language`,
  and each truncation of the request also finds tags that start with it, so `pt-AO` finds `pt-BR` and `en` finds the
  default file before `en-GB`. A new module, `lib/locale.js` (`localeList`, `lookup`, `localeMatches`); content nodes
  carry their default `language`. Unit tests in `test/locale.test.js`.

- **A translation inherits** its default file's `moca.concepts`, `status`, `moca.valid_from` and `moca.valid_until`
  when it writes none, each key on its own, as it already did `moca.audience` (package spec §5.4). `C010` is checked
  on the window each representation ends up with. A new module, `lib/inherit.js`; unit tests in
  `test/inherit.test.js`.

- **A retired translation falls back** (contract §9.2 step 5.4): a search chooses a node's representation among those
  the default retrieval policy and the audience set keep, so a deprecated or ended translation is treated as a missing
  one. When a loaded node's representations differ in those steps, `locale` is applied in the gate, not pushed down
  (§9.5). Unit test in `test/locale.test.js`.
  When the default is not a candidate either, the candidate with the lowest tag. The Reader then passes the filter
  `everyRepresentation`, and the lexical backend returns every matching representation of a node instead of its
  best one, which could be the retired file. A package state carries each file's `status`, window and audience
  (`storedFileKept`), so a store search chooses among the files that pass, as a library search does.

- **The terms gate's place** (contract §9.2 step 5.7): the spec now says what this Reader already did. Comments only.

### Added

- **Relations `translationOf` and `editionOf`** (package spec §7.2): core types, reported with no effect and no
  `R005`. The vendored manifest schema's description names them.
- **Edition groups** (package spec §7.4): `schema:workExample` and `moca:defaultEdition` in a composite's own
  structure make a slot of editions (`O006_EDITION_GROUP_INVALID` for a statement that is ignored). An edition is
  bound to its slot as a part is (`scope`, `nodes()`, `upTo`). With a locale, the gate keeps one edition per slot,
  and its members, where the composite's signers cover the record's package (`editions: 'all'` keeps every one).
  Package states carry each member's `language` and the slots. Structure operations `editions(slot)` and
  `chooseEdition(slot, locale)`. A new module, `lib/editions.js`; unit tests in `test/editions.test.js`.
- **Edition groups, as reviewed** (package spec §7.4): a slot whose IRI is outside its composite's own namespace is
  not read (`O006`), and the statements it makes bind nothing. A slot chooses, once per search, only among editions
  the search can return: loaded, with a file that passes steps 5.1 to 5.3 and the terms gate (`lib/availability.js`,
  `fileSummary`; package states carry `files`, `validFrom` and `validUntil`). A composite that is superseded or out
  of force neither folds nor limits by `upTo`. A slot does not hide when another slot hides its choice
  (`S013_EDITION_SLOTS_DISAGREE`), and a slot that hid records while the search returned nothing from its choice is
  reported (`S012_EDITION_SLOT_EMPTY`). `editions` and `chooseEdition` answer from the declaring composite in force,
  then the highest version (`compareSemver`). Unit tests in `test/editions.test.js`.
- **`localeMode`** in search (contract §9): `choose` (the default), `only` (records in another language drop out, in
  the gate) and `first` (records ordered by the first locale entry they match, then the next; the search asks again
  until `limit` records of the first group pass). Unit test in `test/locale.test.js`.
- **Timed text tracks** (package spec §5.7): `moca.tracks` beside `moca.media`, each `{ media, source, language,
  kind?, label? }`, naming the media description it belongs to; a bad entry is dropped on its own (`C005`, `C006`);
  records carry the tracks that stand in `node.tracks`, `kind` defaulting to `subtitles`. Both vendored schemas
  updated. A 0.7 Reader ignores `moca.tracks` and keeps the media.
- **`moca.language`** (package spec §5.3, §5.4): a default file's own language sets its node's `language`, so its
  `node.locale` and its tag in the lookup; in a translation it is `C005` and ignored. The vendored node schema
  follows moca-spec.
- **`localeCoverage`** in the package result (Reader interface §4): for each language, how many nodes have a
  representation in it, and of how many.
- **`locale` as a priority list** in `Library.citations`, `Library.get` and search (`['fr-CA', 'en']`); the pushdown
  filter `locale` is the list.
- **A store search chooses one representation per node** (contract §9.4), as a library search does, with the
  default file as the fallback: `packageState` lists the files of each node with more than one (`representations`),
  and `storedNode` reads them back. A state without `representations` (from 0.7) is matched as before.

- **After review** (package spec §5.4, contract §9.2): `stale_after` and `moca.contested_by` are inherited, and every
  inherited key, `moca.audience` included, goes through `lib/inherit.js`; a window of one own and one inherited bound
  that is empty fails closed; a translation with its node's own tag is ignored (`C012`); the sibling step keeps to a
  script the entry names; `trimmedLocales` caps a list at 16 entries of 35 characters (`S014`); `localeMode: 'first'`
  stops at `FIRST_BOUND` (1,000) candidates with no host bound (`S010`). `MOCA_VERSION` is `0.8`. Unit tests in
  `test/locale.test.js`.

- **Edition groups after review** (package spec §7.4): `chooseEdition` tags each edition with its `language` and
  `locales`, and falls back to the composite's own language before the lowest id (package states carry members'
  `locales` and the composite's `language`); `O007` for an edition no signer covers; `O006` for near misses of the
  terms; `A011` for a signer whose `ids` entry names no host; `Composer.slotsFor` indexes slots by edition digest, so
  a record costs its own slots only. Unit tests in `test/editions.test.js` and `test/structure.test.js`.

## [0.7.0] - 2026-11-15

For moca-spec 0.7.0 ([moca-spec#5](https://github.com/openmoca/moca-spec/issues/5) and
[moca-spec#7](https://github.com/openmoca/moca-spec/issues/7) and
[moca-spec#8](https://github.com/openmoca/moca-spec/issues/8) and
[moca-spec#9](https://github.com/openmoca/moca-spec/issues/9)).

### Changed (what the terms gate covers)

For moca-spec ADR-0041: everything the Reader hands on for a model goes through the terms gate. Unit tests in
`test/terms-gate.test.js`; corpus cases `terms-mention-*`, `search-terms-mention-*`, `search-store-ingest-*`,
`structure-terms-*` and `catalogue-terms-*` in moca-spec.

- **`ai.allowed.mention`** resolves like every `allowed.*` field, with a platform default of `true` and no node level
  (in a `nodes` entry it is `U003` and has no effect). The vendored terms schema gains it.
- **Closed and hidden** (contract §15.4): `closureOf`, from a package's package-level resolved terms. A new module,
  `lib/terms-gate.js`, gives search, ingest, structure and the catalogue one view of each package's terms.
- **`Library.catalogue`**: what a model may be told about the loaded packages. Vendored `catalogue-entry.schema.json`.
- **`Library.structureFor`**: the structure operations over the packages not closed for a request.
- **`MemoryStoreBackend.ingest(library, { terms, termsLimits })`**: units the gate removes for the embedder's
  destination are never embedded or stored; `ingestDiagnostics` holds `U004`.
- **`U004`** carries `excluded` (removed records by reason) and `hidden` (how many came from hidden packages), in a
  search and in an ingest.
- **Relations name no hidden package**: in a search with a terms request, `trust.supersededBy` and
  `trust.contestedBy` leave out entries that name a package hidden for it, in a library and a store search.

### Changed (limits, exact rules and signer binding)

For moca-spec's hardening pass before 0.7.0: each rule has corpus cases there and unit tests here
(`test/limits.test.js`).

- **A frontmatter escape past U+10FFFF is `C002`** (package spec §5.1, YAML 1.2 §5.7): js-yaml reads
  `"\U00110000"` as two lone surrogates, so the Reader checks double-quoted escapes itself and refuses the
  frontmatter, as the other Readers' YAML libraries do. Corpus case `frontmatter-escape-past-unicode` (moca-spec#32).
- **Structure Turtle is nested at most 64 levels deep** (contract §3), fixed, for `structure.ttl` and host overlays
  alike: each blank-node property list or collection is one level, counted over Turtle's own tokens (n3's lexer), so a
  bracket in an IRI, a string, a comment or a prefixed name never counts, and the check does not recurse. Past it the
  file is `O001` and none of its structure is read. Corpus cases `structure-nesting-at-limit` and
  `structure-nesting-over-limit` (moca-spec#33).

- **Sigstore identities are compared exactly** (attestations §6). The Reader verifies the bundle, reads the issuer and
  subject from the verified certificate, and compares each with the trust root's itself, as a whole string.
  `sigstoreIdentityFor` is the comparison.
- **Offline Sigstore verification makes no request** (attestations §6). Without `sigstore.trustedRoot` and without
  `online`, the only trust material is the copy of the public-good trusted root that ships with the Sigstore library,
  read from its file: no update client is started and no cache is written. With `online`, the trust material is
  refreshed from Sigstore's TUF repository first. The dependency `sigstore` is replaced by `@sigstore/tuf`.
- **`ids` bind a signer to package ids** (moca-spec ADR-0040). A trust-root key or identity with `ids` counts as a
  signer only of packages whose `id` its `ids` cover. Otherwise the new `A010_SIGNER_NOT_FOR_PACKAGE` (error) is
  reported, the attestation's outcome is `invalid`, and the package is not `signed`. An entry without `ids` signs any
  id, as before.
- **The terms gate fails closed** (contract §15.3, §15.4): a container in `terms` that is present with the wrong type
  (`ai`, `ai.allowed`, `rights`, `rights.export`, `nodes`, a `nodes` entry) sets everything under it to its strictest;
  a record rated only under a scheme the host did not list is unrated; a malformed rating counts as explicit and
  outside every listed scheme; a rating request with a member this version does not define (such as the drafted
  `mode`) removes every record, counted as `rating.request` in `U004`.
- **New limits** (contract §3): `maxAttestations` (256) and `maxAttestationBytes` (1 MiB), `A001` past either; at most
  16 signature entries in one DSSE envelope (`MAX_SIGNATURES`, also enforced by `verifyEnvelope`); and the members of
  every collection in a structure file, added together, counted against `maxTriples` (`O001`). A member list that
  several collections share is walked once, and a long list is indexed in linear time.
- **Archive records are checked before any entry is read** (contract §3): exactly one end-of-central-directory record
  at the end of the file, no multi-disk or Zip64 archive, a directory that holds what it declares, and local headers
  whose name and method match it. Otherwise `T003`.
- **A manifest of the wrong shape never throws** (contract §5): a `moca.json` that is JSON but not an object is `M002`
  and the read stops; a `locales` of the wrong type declares no locale.
- **Text work is linear** (contract §3): links in a node's body, and Markdown and HTML evidence sources, are scanned
  in one pass (`linkTargets`, and the scanners in `evidence-text.js`) with the same results as before.
- **Structure: prefix declarations are found in one pass** (contract §3), in `structure.ttl` and host overlays alike
  (`declaredPrefixes`), with the same prefixes as before. Unit tests in `test/linear-scans.test.js` compare it with
  the expression it replaces and count its steps.
- **Entry names: trailing slashes are removed in one pass** (contract §3), for archive entries and host sources
  (`withoutTrailingSlashes`), with the same names as before.
- **log.md: date headings are read in one pass** (contract §3, package spec §5.1): `##`, white space, then the rest
  of the line, whatever it holds (`logHeading`). A heading that holds a carriage return, a line separator (U+2028) or
  a paragraph separator (U+2029) and no date is now `C004`, as in the other Readers. Corpus cases `log-heading-cr`
  and `log-heading-line-separator`.
- **Dependencies**: `@sigstore/verify` 4.1.3 and `@sigstore/bundle` 5.0.1, in `package-lock.json`.

### Changed (a nesting limit)

- Contract §3: JSON and YAML frontmatter are nested at most 64 levels deep (`MAX_NESTING`), counting the outermost
  object or mapping. JSON is checked in one pass before it is parsed (`nestedTooDeep`, `parseJson`): `moca.json`
  (`M001`), attestation files and their statements (`A001`), `moca-enc.json` (`E005`), and a sidecar's `index.json`
  (`S001`) and payload lines (`S004`). Frontmatter is loaded with the YAML library's depth limit set to 64 (its
  default is 100), and deeper frontmatter is `C002`. The check for long implicit keys uses the same limit and can no
  longer throw.

### Fixed (found by an independent review)

- Reader contract §7: a citation record's `trust.generated` now keeps `model` (the model's name and version) when the
  node's OKF `generated` states it. Caught by the spec's new machine-made cases.

- Contract §15.3 step 3: a composing package's stricter `ai` and export terms now apply to its members' records when
  its signers speak for the member (as for `upTo`), or the host allows unsigned packages to. Before, a member's own
  terms were used alone.
- Contract §7, §9.2: search de-duplication now keys on the whole span (start and end), so two chunks of one node that
  share a start are both kept.
- Reader contract §11: the summaries in `CODES` for `E002`, `E005`, `E006`, `C002`, `A001`, `R002`, `M010` and `M009`
  now match the contract's wording. The `M009` message says the package is read under the newest rules the Reader
  implements, not on a best-effort basis.

### Added (rights and dates: package spec §4.12, §4.14; Reader contract §7, §15.3)

- The package result carries `datePackaged`, as written, when the manifest passes its schema; citation records carry
  `package.datePackaged`.
- Terms gain `rights.export.allowed`, `rights.copyright`, `rights.notice` and `rights` (`license`, `copyright`) in
  `terms.nodes` entries, checked with the rest of `terms` (a copyright year range out of order is `U001`).
- Citation records carry `node.license` and `node.copyright`: the node's `terms.nodes` entry first, else the
  manifest's `license` and `terms.rights.copyright`; a value with a terms problem is skipped.
- Records from a search with a terms request carry `terms.rights.export`, resolved from the package (platform
  default `true`; a malformed value counts as `false`). Export removes nothing from a search.
- Vendored manifest, terms and citation-record schemas updated.

### Added (credits: package spec §4.13)

- The package result carries `publisher` (an object), `url` and `contributors`, as written, when the package is
  valid; citation records carry `node.contributors` from a node's `moca.contributors`. A credit's image is checked
  as a manifest image (`M010`) and left out when it fails. Credits are labels, not proof. Vendored manifest, node
  and citation-record schemas updated; `publisher` as a string now fails the schema (`M002`).

### Added (the creator's terms: package spec §4.14, Reader contract §15)

- `pkg.terms`: `{ declared, problems, authority }`. The manifest's `terms` exactly as written, its problems
  (`U001_TERMS_INVALID`, `U003_TERMS_UNKNOWN_VALUE`, warnings, never `M002`), and the authority, `packager` or
  `unverified`, from the package's signatures only. `U002_TERMS_LOOSENED` for a node value looser than the package's.
- Permissions are booleans under `ai.allowed` (`device`, `host`, `provider`, `training`, `machineTranslation`); provider
  conditions are `noTraining` and `noRetention`. Every level only makes the platform defaults stricter: in 0.7.0 no
  package can loosen them, so `ai.allowed.training: true` has no effect.
- `search(query, { terms })` applies the terms gate and adds each record's resolved `terms`; `termsLimits` are the
  host's floors. Records removed are counted in `U004_TERMS_EXCLUDED` (info). Without a terms request nothing changes.

### Changed (alternative labels and ingress narrowing: package spec §5.6, Reader contract §9.2, §9.4)

- `skos:altLabel` is read: concepts carry `altLabels` by language, in the order read, each once; the default
  ontology-guided ingress matches a preferred or an alternative label, as written.
- Concepts or a scope an ingress hook sets now narrow the search under composition and with backends that have no
  pushdown: resolved hits are narrowed after the backend, before the egress hook and the gate, on every round.
- A store search takes a structure source (`Search` takes `structure` in a store source): a library whose structure the hooks see and `scope` follows.

### Changed (filters come before the limit: Reader contract §9.2)

- `Search` returns the best `limit` records that pass the gate, however far down the unfiltered ranking they are. The
  fixed cap of 200 candidates is gone: it asks the backend again, doubling the request, until `limit` records pass or
  the backend returns fewer hits than asked. An egress hook runs again on each larger candidate list.
- New option `maxCandidates` on `Search`: the host's bound on one call. A call it stops reports
  `S010_SEARCH_TRUNCATED` (warning) in `search.diagnostics`. Unset by default.
- `LexicalBackend` and `MemoryStoreBackend` score over every representation of the loaded packages, then apply the
  filters, so a pushed-down filter never changes a score. The lexical and dense backends also apply the search's own
  check for `upTo` and for concepts bound by composition, so such a search usually needs one request.
- `HybridBackend` fuses each backend's whole ranking before filters, and keeps it for the rest of one search call;
  `DenseBackend` embeds a query once however often it is asked again.

### Added (podcast and video series content: package spec §4.12, §5.6, §5.7, §7.1–§7.3; sidecar spec §5)

- Media descriptions (`moca.media`): validated (`C005`, `C006`), exposed as `node.media`, never fetched. A time range
  that cites hosted media is checked against its `transcript` and counts toward `self-contained-evidence`.
- Time ranges must also end within the media: at or before the latest cue end, or the declared duration when later.
- `datePublished` on the result and `package.datePublished` on records; the node's own `node.datePublished`.
- Binding by composition: a composing package's structure binds its resolved members' records for `concepts`,
  `scope`, `upTo` and the structure operation `nodes()`; `upTo` limits the members of a package whose reading
  order places it. Package states carry `composition`, so store searches agree. With bindings loaded, the `concepts` filter is applied in the gate only.
- `isPartOf` is a core relation type; `R005_RELATION_TYPE_UNKNOWN` (info) for other undefined types.
- An issued copy matches a member pin, and binds the publisher's sidecar, through its verified original digest. Items of
  changed files are replaced by whole-body chunks without vectors (`S009_SIDECAR_ITEMS_REPLACED`).
- Alternate media (package spec §5.7): `alternateOf` and `sync` in `moca.media`, validated (`C005` for an
  invalid alternate) and carried in `node.media`. A time range on an alternate with no transcript is checked through its
  reference's transcript. `mapTime(record, from, to, t)` maps a moment between alternates.
- `maxMembers` defaults to 4,096 (was 256).
- A refined quote is located in linear time (one Knuth-Morris-Pratt pass, constant-time spans); `located` runs from
  the earliest start to the latest end of the touched cues; white space means the five ASCII characters.
- An open-ended range on an alternate runs to the end of its stretch, and a range must end within the alternate's own
  duration. A repeat of a member id (M005) is not resolved. `.inf`, `.nan` and numbers too large to be finite are
  neither numbers nor strings.
- A media time range may carry a `TextQuoteSelector` as its `refinedBy` (contract §7): it matches when the range does
  and the quote is in the cues the range covers, white space collapsed. `evidence[].located` gives the cue-precise
  span, the shortest of several occurrences, also through alternates.
- A composer's reading order limits a member only when the composer's signers' `ids` cover the member's `id`, or the
  host sets `allowUnsignedRelations` (contract §9).
- Contract §3: a member met more than once in one read is resolved and read once, and shared; it counts once.
  New limit `maxMemberBytes` (1 GiB) on the bytes of all the members one read reads. A reading order is walked once,
  and bindings by composition keep only direct bindings and the links above them, so both take linear work. Package
  states carry that form.
- `upTo` limits a member's records by their own concepts on every composer's reading order, bound by composition
  or not.
- A source whose `id` is not a string has no `id` in every lookup.
- `duration: .inf` and other non-finite numbers fail the node schema where it wants a number (`C005`), as in the
  other Readers.
- Frontmatter whose `sources` has two entries with the same `id` is `C002_FRONTMATTER_INVALID` (package spec
  §5.1), so the node is not read. Before, this Reader used the last entry.
- Contract §3: the evidence budgets (`maxEvidenceChecksPerPackage`, `maxEvidenceBytesPerPackage`) cover the whole
  read, so a package and its members share them. Each transcript's cues are parsed once per package, not once per
  time range checked.
- A number too large to be finite, such as `1e400` or a very long integer, is read as `.inf` is (package spec §5.1),
  not as a string. No step spreads a long list into one call's arguments, so a transcript of many cues is checked.
- An implicit mapping key longer than 1,024 characters is `C002_FRONTMATTER_INVALID`, as YAML 1.2 says and as in
  the other Readers (package spec §5.1).

### Changed (encrypted packages: hardening)

- Opening an envelope never throws to the caller: an unexpected failure is
  `E006` while parsing the header and `E002` after. This Reader takes no
  cancellation signal, so an `AbortError` from a key provider or decryptor
  (its own timeout) is a failure like any other.
- `limits.maxScryptWorkFactor` must be an integer from 1 to 22; anything else
  is refused as a host error when `readPackage` or `bindEnvelopeSidecar`
  starts, and `parseHeader` refuses it too. Left out or `undefined`, it is the
  default (20).
- The key provider's result is checked: not an object is `E001`, a member of
  the wrong type (`identities: null` among them) or a file key that is not
  16 bytes is `E002`. A result with
  several kinds is tried identities, passphrase, then file key.
- The plaintext length is computed from the payload length before any
  decryption (`T003` over `maxBytes`, `E003` when impossible), and the
  payload is decrypted into one buffer of that size. The header is parsed
  from its first 64 KiB only. The ciphertext and the plaintext are passed on
  as views, never copied: an archive given as bytes is read in place, so
  the host must not change those bytes during the read.
- A key provider's error message never appears in a diagnostic.
- Key material and partial plaintext are zeroed after use where Node allows.
- At most 256 recipient stanzas (`E006`).
- scrypt runs asynchronously, off the event loop: `ageDecryptor.decrypt` now
  returns a promise. `createAgeDecryptor` makes one with another scrypt, for
  tests. Called directly, `decrypt` applies the default `maxBytes`.
- Tests: the hybrid CCTV vectors run parse-only; provider results; limits;
  the header size; CI installs the Go age CLI and requires it on Linux.

### Added (attestations §3a and §7.1: issued copies)

- Issued-copy attestations (`PREDICATE_ISSUED_COPY`, `issuedCopyStatement`)
  are verified first, with the trust-root role `issued-copy` (which needs
  `ids`) and the publisher's consent in `issuedCopies`. The Reader rebuilds
  the original digest (`rebuiltDigest`), and package attestations are then
  checked against it. Every failure is `A002`.
- `result.issuedCopy`: `{ originalDigest, issuers, changedFiles }`. Citation
  records carry `package.issuedCopy` and `node.issuedChange`; reviews of
  changed files are listed with `fileChanged: true` and never count, and such
  a copy is not `reviewed`.
- `Library.add`: a second issued copy of the same original is
  `L002_ISSUED_COPY_DUPLICATE` (info), not `L001`.
- `packageState` carries `issuedCopy`, so a store search recomputes it.
- `ed25519KeyBytes` compares keys as bytes. The manifest, trust-root and
  citation-record schemas are copied from moca-spec.

### Added (package spec §4.10, Reader contract §9)

- `readingOrder` in the package result when it names an ordered collection
  with a member list in the package's own `structure.ttl`; otherwise
  `M014_READING_ORDER_UNRESOLVED` (warning) and it is ignored.
- The search option `upTo`: in a package whose reading order places it (a
  member, or a descendant placed at the first member that contains it),
  records bound to a concept placed after it are left out. Records off the
  reading order, and other packages, are not limited. It runs in the gate
  and follows the caller only. When no loaded reading order places it,
  `search.diagnostics` holds `S008_UPTO_UNRESOLVED` (warning).
- `packageState` carries the reading order, so a store search applies
  `upTo` too.

### Added (package spec §4.9)

- `apps` in the package result, as declared, when the manifest passes its
  schema. Advice only: the Reader never fetches, resolves or opens an app
  URI. `apps` may be an outline property of an envelope.

### Added (package spec §4.6–4.8)

- `images`, `translations` and `tags` in the package result when the package
  is valid. Each image is checked for presence, `limits.maxImageBytes`
  (default 1 MiB) and the PNG, JPEG or WebP signature of its type, never
  decoded (`M010`). Translation keys must be declared locales (`M011`);
  repeated tags are dropped (`M012`); translated alt text for an unknown
  image is dropped (`M013`).
- Envelopes: the opt-in cover copy (`outline/cover.png`, `.jpg` or
  `.webp`), at most one and within `maxImageBytes` (`E005`), checked
  against the inner manifest's first cover (`E004`). `translations` and
  `tags` may be outline properties.
- The manifest and moca-enc schemas are copied from moca-spec.

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
