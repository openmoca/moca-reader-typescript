import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokens } from '../lib/backends/bm25.js';
import { readPackage, Library, Search, LexicalBackend } from '../lib/index.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The same vectors are in moca-reader-dotnet's tests: every Reader's built-in
// lexical backend must tokenise identically.
const vectors = JSON.parse(readFileSync(new URL('./fixtures/token-vectors.json', import.meta.url), 'utf8'));
const repo = process.env.MOCA_SPEC_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'moca-spec');

for (const v of vectors) {
  test(`tokens: ${v.why}`, () => assert.deepEqual(tokens(v.text), v.tokens));
}

test('without a locale, lexical search finds content in every language', async () => {
  const library = new Library().add(await readPackage(join(repo, 'examples', 'support-kb')));
  const search = new Search(library, { backend: new LexicalBackend(library) });
  const [hit] = await search.search('remboursement', { limit: 1 });
  assert.equal(hit?.node.path, 'refund-window.md');
  assert.equal(hit.node.locale, 'fr');
  assert.deepEqual(await search.search('remboursement', { locale: 'en' }), []);
});
