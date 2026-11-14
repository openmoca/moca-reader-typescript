import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPackage, loadTrustRoot, packageState, citationFor, ed25519KeyBytes, Library, Search, MemoryStoreBackend } from '../lib/index.js';

// Attestations §3a and §7.1. The corpus covers the rules; these cover what it cannot.
const SPEC = process.env.MOCA_SPEC_DIR ?? join(import.meta.dirname, '..', '..', 'moca-spec');
const FIX = join(SPEC, 'conformance', 'fixtures');
const TRUST = JSON.parse(readFileSync(join(FIX, 'trust-root-issued.json'), 'utf8'));
const clock = () => new Date('2026-09-27T00:00:00Z');

test('a trust root that gives issued-copy without ids is refused', () => {
  const doc = structuredClone(TRUST);
  delete doc.keys.find((k) => k.roles.includes('issued-copy')).ids;
  assert.throws(() => loadTrustRoot(doc), /invalid trust root/);
});

test('keys are compared as Ed25519 bytes, not as PEM text', () => {
  const pem = readFileSync(join(SPEC, 'fixtures', 'signing-keys', 'INSECURE-issuer.pub.pem'), 'utf8');
  const folded = pem.replace(/\n(?!-----END)/g, '\r\n');
  assert.ok(ed25519KeyBytes(pem).equals(ed25519KeyBytes(folded)));
  assert.equal(ed25519KeyBytes('not a key'), null);
});

test('a store search recomputes issuedCopy and issuedChange from the package state', async () => {
  const r = await readPackage(join(FIX, 'issued', 'copy-valid'), { trustRoot: TRUST, clock });
  const state = JSON.parse(JSON.stringify(packageState(r)));
  assert.deepEqual(state.issuedCopy.changedFiles, ['content/lessons/one.md']);
  const store = await new MemoryStoreBackend({ filterPushdown: false }).ingest(new Library({ clock }).add(r));
  const records = await new Search({ packages: [state], clock }, { backend: store }).search('lesson', { limit: 10 });
  const one = records.find((x) => x.node.path === 'lessons/one.md');
  assert.equal(one.node.issuedChange, true);
  assert.equal(one.package.issuedCopy.originalDigest, r.issuedCopy.originalDigest);
  // The same records against a state without the issued copy (an issuer the host no longer trusts) lose both.
  const plain = { ...state };
  delete plain.issuedCopy;
  const again = await new Search({ packages: [plain], clock }, { backend: store }).search('lesson', { limit: 10 });
  assert.ok(again.every((x) => x.node.issuedChange === undefined && x.package.issuedCopy === undefined));
});

test('a record from an unchanged file has no issuedChange', async () => {
  const r = await readPackage(join(FIX, 'issued', 'copy-valid'), { trustRoot: TRUST, clock });
  const intro = r.nodes.find((n) => n.path === 'intro.md');
  const rec = citationFor(r, intro, intro.representations[0], { now: clock() });
  assert.equal(rec.node.issuedChange, undefined);
  assert.equal(rec.package.issuedCopy.issuers.length, 1);
});
