import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, RETIRED_CODES } from '../lib/index.js';

const repo = process.env.MOCA_SPEC_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'moca-spec');
const contract = readFileSync(join(repo, 'spec', 'moca-reader-contract.md'), 'utf8');

test('the diagnostic codes and severities match the Reader contract §11 table', () => {
  const table = Object.fromEntries([...contract.matchAll(/^\| `([A-Z]\d{3}_[A-Z0-9_]+)` \| (error|warning|info) \|/gm)].map((m) => [m[1], m[2]]));
  const ours = Object.fromEntries(Object.entries(CODES).map(([code, { severity }]) => [code, severity]));
  assert.deepEqual(ours, table);
});

test('the retired codes match the Reader contract', () => {
  const line = contract.split('\n').find((l) => l.startsWith('Retired codes'));
  assert.deepEqual([...RETIRED_CODES].sort(), [...line.matchAll(/`([A-Z]\d{3}_[A-Z0-9_]+)`/g)].map((m) => m[1]).sort());
});

test('the registered URN namespaces equal moca-spec data/urn-namespaces.json (M007)', async () => {
  const { REGISTERED_URN_NIDS } = await import('../lib/manifest.js');
  const snapshot = JSON.parse(readFileSync(join(repo, 'data', 'urn-namespaces.json'), 'utf8'));
  assert.deepEqual([...REGISTERED_URN_NIDS].sort(), snapshot.formal);
});
