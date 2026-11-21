# Fuzzing

Packages are untrusted archives, so the Reader's open-and-search path is fuzzed with
[Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js), a coverage-guided fuzzer, seeded from moca-spec's
conformance corpus.

| Target | Input | What fails it |
| --- | --- | --- |
| `open-search.fuzz.js` | Archive bytes, read with `readPackage` | Any exception other than a `TargetError`, or a search of a package that read that throws |
| `package-files.fuzz.js` | One file of a valid package replaced (manifest, frontmatter, Turtle) | The same |

A crash, a timeout or running out of memory is a bug: fix it, and add the input to moca-spec's corpus or this
repository's tests.

## Run locally

With moca-spec checked out beside this repository:

```sh
npm ci                      # the Reader's own dependencies
cd fuzz && npm ci           # Jazzer.js, kept apart from the Reader's lockfile
npm run seed                # builds corpus/ and corpus-files/ from ../../moca-spec
npm run fuzz:open -- -max_total_time=60
npm run fuzz:files -- -max_total_time=60
```

Set `MOCA_SPEC_DIR` if moca-spec is elsewhere. The targets are asynchronous, so never pass Jazzer.js `--sync`.

## In CI

`.github/workflows/fuzz.yml` runs each target for 60 seconds on pull requests that touch `lib/` or `fuzz/`, and for
30 minutes nightly, keeping the corpus between nightly runs. Crashing inputs are uploaded as an artifact.
