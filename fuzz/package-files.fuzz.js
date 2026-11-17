// Fuzz target: a valid package with one file replaced by fuzzed bytes, read through a host source, so the
// mutations reach the manifest, frontmatter, YAML, Turtle and evidence parsers instead of stopping at the
// archive's checksums. The base is moca-spec's `reading-order` fixture (MOCA_SPEC_DIR; by default, moca-spec
// beside this repository). The rule is the same as open-search.fuzz.js: never throw anything but a TargetError,
// and a package that reads must search without throwing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuzzedDataProvider } from '@jazzer.js/core';
import { readPackage, Library, Search, LexicalBackend, TargetError } from '../lib/index.js';

const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../moca-spec', import.meta.url));
const base = join(resolve(spec), 'conformance', 'fixtures', 'reading-order');
const files = new Map();
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else files.set(relative(base, p).split('\\').join('/'), readFileSync(p));
  }
};
walk(base);
const paths = [...files.keys()].sort();

export async function fuzz(data) {
  const fdp = new FuzzedDataProvider(data);
  const target = paths[fdp.consumeIntegralInRange(0, paths.length - 1)];
  const bytes = fdp.consumeRemainingAsBytes();
  const source = {
    list: () => paths,
    read: (path) => (path === target ? bytes : files.get(path)),
  };
  let pkg;
  try {
    pkg = await readPackage(source, { limits: { maxEntries: 64, maxBytes: 4 * 1024 * 1024 } });
  } catch (err) {
    if (err instanceof TargetError) return;
    throw err;
  }
  if (!pkg.valid) return;
  const library = new Library().add(pkg);
  const search = new Search(library, { backend: new LexicalBackend(library), audiences: ['public'] });
  await search.search('module', { limit: 5 });
  if (pkg.readingOrder) await search.search('module', { upTo: pkg.readingOrder });
}
