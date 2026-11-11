# Getting started with the TypeScript Reader

Install the reference MOCA Reader, open an example package, search it and cite
what you find, then run the conformance corpus. You need Node.js 22 or later
and about ten minutes.

## 1. Install the Reader

```sh
mkdir moca-start && cd moca-start
npm init -y
npm pkg set type=module
npm install @openmoca/moca-core
```

## 2. Get an example package

`support-kb` is a small customer-support knowledge base: a refund policy in
English and French, a shipping guide, and an internal account-deletion
procedure. It is signed, one node has a signed review, and the refund policy
quotes the customer terms it came from, which travel inside the package.

```sh
curl -fsSLO https://github.com/openmoca/moca-spec/releases/download/v0.6.0/support-kb.moca
curl -fsSLO https://github.com/openmoca/moca-spec/releases/download/v0.6.0/example-trust-root.json
```

The trust root says whose signatures you accept, and for what. This one trusts
the example keys, which are published on purpose: use it for the examples
only. To make your own, see
[your trust root](https://github.com/openmoca/moca-spec/blob/main/docs/guides/consuming.md#your-trust-root).

## 3. Open it

```js title="open.js"
import { readPackage } from '@openmoca/moca-core';

const pkg = await readPackage('support-kb.moca', { trustRoot: 'example-trust-root.json' });
if (!pkg.valid) {
  for (const d of pkg.diagnostics) console.error(`${d.code} ${d.message}`);
  process.exit(1);
}

console.log(pkg.digest);
console.log(pkg.capabilities.join(', '));
```

```sh
node open.js
```

```text
sha256:4992176b90ea0992037617ee56d5dcafecf60aeb400cfa9369c9164453df96da
core, localized, located-evidence, reviewed, self-contained-evidence, signed
```

The digest covers every file in the package: change one byte and it changes.
`signed` and `reviewed` appear because the signatures verify against your trust
root; without one, they are reported as unverifiable. `readPackage` never
throws for a bad package: problems come back as diagnostics with stable codes.

## 4. Search and cite

```js title="search.js"
import { readPackage, Library, Search, LexicalBackend } from '@openmoca/moca-core';

const pkg = await readPackage('support-kb.moca', { trustRoot: 'example-trust-root.json' });
const library = new Library().add(pkg);
const search = new Search(library, { backend: new LexicalBackend(library), audiences: ['public'] });

const [hit] = await search.search('How long is the refund window?', { limit: 1 });
if (!hit) throw new Error('no result');

console.log(hit.text.trim());
console.log();
console.log(`Source:   ${hit.node.title} (${hit.node.ref})`);
console.log(`Package:  ${hit.package.id} ${hit.package.version}, signed: ${hit.package.signed}`);
console.log(`Digest:   ${hit.package.digest}`);
console.log(`Reviewed: ${hit.trust.attestedReviews.map((r) => r.reviewer).join(', ') || 'no'}`);
console.log(`Evidence: ${hit.evidence.every((e) => e.matched) ? 'every quote found in its source' : 'not all checked'}`);
```

```sh
node search.js
```

Each result is a **citation record**: the text, plus the package, version and
digest it came from, a versioned reference to the node, its trust signals, and
its evidence, marked `matched` when the quote was found in the original. Show
your users where an answer came from, and log the digest with the answer so you
can prove later what was read.

The search left out the internal account-deletion procedure: you asked for the
`public` audience only, and nothing a caller does can widen that. It also
leaves out content that is superseded, out of force or deprecated, unless you
pass `includeAll: true`.

When you hand results to a model, pass the text as quoted reference material,
never as instructions
([Reader contract §12](https://github.com/openmoca/moca-spec/blob/main/spec/moca-reader-contract.md#12-handing-content-to-a-model)).

## 5. Run the conformance corpus

The corpus is how every MOCA Reader, in any language, shows it reads packages
the same way. Run it against this Reader:

```sh
cd ..
git clone --depth 1 --branch v0.6.0 https://github.com/openmoca/moca-spec.git
cd moca-spec
npm ci
npm run conformance
```

```text
All 196 conformance case(s) pass.
```

## Next

- [Consuming packages](https://github.com/openmoca/moca-spec/blob/main/docs/guides/consuming.md):
  your own retrieval stack, structure, dense search and MCP.
- [moca-examples](https://github.com/openmoca/moca-examples#readme): a command
  line and a chat over a package.
- [The API](../README.md#api).
