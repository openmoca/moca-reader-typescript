// Fuzz target: open an untrusted archive and search it (moca-spec SECURITY.md, "Archive handling in the
// Readers"). Jazzer.js calls fuzz() with mutated bytes, seeded from the conformance corpus (seed.mjs). A package
// is untrusted input, so readPackage must never throw anything but a TargetError, and a package it reads must be
// searchable without throwing.
import { readPackage, Library, Search, LexicalBackend, TargetError } from '../lib/index.js';

const LIMITS = { maxEntries: 512, maxBytes: 8 * 1024 * 1024 };
const QUERIES = ['refund', 'the', 'a b c'];

export async function fuzz(data) {
  let pkg;
  try {
    pkg = await readPackage(new Uint8Array(data), { limits: LIMITS });
  } catch (err) {
    if (err instanceof TargetError) return; // a refused archive is a correct outcome
    throw err;
  }
  if (!pkg.valid) return;
  const library = new Library().add(pkg);
  const search = new Search(library, { backend: new LexicalBackend(library), audiences: ['public'] });
  for (const q of QUERIES) await search.search(q, { limit: 5 });
  if (pkg.readingOrder) await search.search(QUERIES[0], { upTo: pkg.readingOrder });
}
