# @openmoca/moca-core

The reference MOCA Reader, in TypeScript/JavaScript: open a package from a
directory, a `.moca` archive or a host-supplied source; check it; compute its
digest; verify attestations and evidence; resolve members; produce citation
records; and search with one entry point over lexical, dense-sidecar or store
backends. It implements the Reader class of the
[Reader contract](https://github.com/openmoca/moca-spec/blob/main/spec/moca-reader-contract.md), follows the
[Reader interface](https://github.com/openmoca/moca-spec/blob/main/spec/moca-reader-interface.md), and passes the
[conformance corpus](https://github.com/openmoca/moca-spec/blob/main/conformance/README.md).

## Install

```sh
npm install @openmoca/moca-core
```

Node.js 22 or later. [Getting started](docs/getting-started.md) takes you from
install to a cited search result and a conformance run in five steps. Example packages are in
[moca-spec](https://github.com/openmoca/moca-spec/tree/main/examples), and
[moca-examples](https://github.com/openmoca/moca-examples#readme) has a
command line and a chat built on this Reader.

## Lexical search

The built-in lexical backend is BM25 (k1 1.2, b 0.75) over node text, or over
sidecar chunks when a sidecar is bound. Every MOCA Reader tokenises the same
way, so they return the same results:

- NFKC-normalise, then lower-case each code point (simple case mapping).
- Letters, digits and combining marks make words; anything else separates
  them. Words in scripts with vowel signs, such as Devanagari, stay whole.
- Chinese, Japanese, Thai, Lao, Khmer and Myanmar text is split into each
  character (with its marks) and each pair of neighbouring characters.
- No stemming. A host that needs it supplies its own lexical backend.
- Without a locale, every language of a node is searched and its best match
  returned; with one, the representation package spec §5 selects.

Characters added in very recent Unicode versions can tokenise differently
across Readers, because each language runtime ships its own Unicode data.

## Conformance

As [Reader contract §14](https://github.com/openmoca/moca-spec/blob/main/spec/moca-reader-contract.md#14-demonstrating-conformance)
asks:

| | |
| --- | --- |
| Class | Reader (the reference Reader) |
| Contract version | 0.6.0 |
| Optional capabilities | All implemented: archives, host sources, Sigstore bundle verification (offline, online when `online` is set), sidecars (lexical and dense), the ontology profile, `encryption` (with `@openmoca/moca-core/age`) |

```js
import { readPackage, Library, Search, LexicalBackend, directoryResolver } from '@openmoca/moca-core';

const pkg = await readPackage('kb', { trustRoot: 'trust-root.json', resolveMember: directoryResolver(['./packages']) });
pkg.valid;          // boolean
pkg.digest;         // 'sha256:…'
pkg.capabilities;   // ['core', 'signed', ...]
pkg.distribution;   // 'open', 'encrypted-only' or 'service-only': the publisher's intent, a label only
pkg.images;         // [{ src, role, type, sizes?, alt? }]: the images that passed their checks; read the bytes from the package
pkg.translations;   // { fr: { title?, description?, tags?, alt? } }: the manifest's own text per declared locale
pkg.tags;           // ['refunds', ...]: without repeats
pkg.diagnostics;    // [{ code, severity, message, file?, line? }]

const library = new Library().add(pkg);
const search = new Search(library, { backend: new LexicalBackend(library), audiences: ['public'] });
await search.search('refund window', { limit: 5 }); // citation records, each with a score
library.get('https://example.com/moca/support-kb#refund-window.md', { locale: 'fr' });
```


## Encrypted packages

Envelopes ([encrypted packages](https://github.com/openmoca/moca-spec/blob/main/spec/moca-encrypted-package.md))
open only when the host passes the age decryptor and a key provider. The core never imports the decryptor, so a host
that does not want it never loads it.

```js
import { readPackage, bindEnvelopeSidecar } from '@openmoca/moca-core';
import { ageDecryptor } from '@openmoca/moca-core/age';

const options = {
  decryptor: ageDecryptor,
  // Keys come from host configuration only, never from the envelope or its outline.
  keyProvider: ({ stanzas, outline, file }) => ({ identities: [process.env.MOCA_AGE_IDENTITY] }),
};
const pkg = await readPackage('handbook.moca.enc', options);
pkg.envelope;       // { format: 'moca-enc-v1', opened: true }, or opened: false with the unverified outline
const index = await bindEnvelopeSidecar('handbook.moca.enc', pkg, options); // index.age, if the envelope has one
```

Without `decryptor`, an envelope is reported with `E001` and nothing inside it is exposed. Decrypted bytes stay in
memory; the Reader never writes them to a file.
## API

| Export | Purpose |
| --- | --- |
| `readPackage(target, options)` | Read and check a package. `target`: path, `.moca`/`.zip` path, or `{ list(), read(path) }`. Options: `trustRoot`, `resolveMember`, `strict`, `limits`, `online`, `allowOfflineFallback`, `tufCachePath`. |
| `Library` | Holds verified packages (and their sidecar `chunks` and `index`); `citations()`, `get()`, and `search()` as a synchronous lexical shortcut; applies relations. Takes a `clock` for testing. |
| `Search` | One entry point over a backend: `search(query, { limit, includeAll, locale, concepts, scope })`, with optional `hooks: { ingress, egress }`. The gate always runs last ([Reader contract §9](https://github.com/openmoca/moca-spec/blob/main/spec/moca-reader-contract.md#9-search)). `new Search({ digests, clock }, { backend })` searches a store from its ingest-time records. |
| `LexicalBackend`, `DenseBackend`, `MemoryStoreBackend` | Backends: BM25 over package text or sidecar chunks; sidecar vectors with a host embedder (`S006` on a model mismatch, `S007` for a package without vectors); a reference in-memory store. |
| `selectorMatches(selector, text)` | The evidence check behind `evidence[].matched` and `C011`. |
| `bindSidecar(target, pkg)` | Check a sidecar against a package and return usable chunks. |
| `directoryResolver(dirs)` | A simple member resolver over folders. |
| `hostSource`, `archiveSource`, `directorySource` | Package sources. |
| `loadTrustRoot`, `verifySignature`, `packageStatement`, `reviewStatement`, `createEnvelope` | Attestation primitives, shared with `moca-sign`. |
| `computeDigest`, `packageFiles` | The digest algorithm. |
| `validateAgainst(name, value)`, `SCHEMAS` | The `schemas/v1` schemas. |
| `Library.structure` | Structure operations over the loaded packages and the host's overlays: `concept`, `requires`, `requiredBy`, `parts`, `narrower`, `broader`, `related`, `sequence`, `nodes`. Each item names its layer. `new Library({ overlays })` loads overlays. |
| `ontologyGuided()` | The default ingress/egress hooks for `Search`. |
| `HybridBackend({ lexical, dense, k, weights })` | Opt-in: a lexical and a dense backend merged by Reciprocal Rank Fusion, Σ weight / (k + rank); k 60 and weights 1 by default, set by the host. Packages dense search skips come back through the lexical side. |
| `diversify({ perNode })` | Opt-in egress hook: each node's best `perNode` results first (default 1), the rest after, so one node's chunks don't fill the list. |
| `readStructure`, `structureView` | Parse `structure.ttl` (with `n3`) and print a sorted JSON view of it. |
| `KNOWN_PROFILES`, `PROFILE_ONTOLOGY` | Recognised profiles; profile data stays opaque. |
| `CODES`, `formatText`, `formatJson`, `formatSarif` | Diagnostics. |

`readPackage` never executes package content and performs no network I/O,
except online Sigstore checks when `online` is set. Ontology files are parsed
locally; `owl:imports` is reported, never followed. Embedders are supplied by
the host, never named by a package.

`lib/schemas/` holds byte-identical copies of moca-spec's `schemas/v1`, checked
by `npm run check:schemas`.

## Develop

The tests read moca-spec's examples and fixtures. Check out moca-spec beside
this repository, or set `MOCA_SPEC_DIR`. CI uses the tags pinned at the top of `.github/workflows/test.yml`
(`MOCA_SPEC_REF` and the like); check out the same tags to match it.

```sh
npm install
npm test
```

## Release

1. Add a dated section to [CHANGELOG.md](CHANGELOG.md) and update the version.
2. Point the `MOCA_*_REF` pins in `.github/workflows/test.yml` at the release tags
   ([moca-spec docs/releasing.md](https://github.com/openmoca/moca-spec/blob/main/docs/releasing.md#moving-the-pins)).
3. `npm test` passes.
4. Tag `vX.Y.Z` and publish a GitHub release whose notes are the changelog
   section.
5. `npm publish --access public` from the tagged commit. Publish this package
   before the tools that depend on it.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

OpenMOCA™ is a trade mark of PI & Mash Solutions Ltd. The licence covers the
code, not the name: see the
[trade mark policy](https://github.com/openmoca/moca-spec/blob/main/TRADEMARKS.md).
