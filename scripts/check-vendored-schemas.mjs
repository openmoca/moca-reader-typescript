#!/usr/bin/env node
// This package ships copies of moca-spec's schemas/v1/*.schema.json so it works
// on its own. The copies must stay byte-identical. The spec is read from
// MOCA_SPEC_DIR, or from a moca-spec folder beside this repo.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = process.env.MOCA_SPEC_DIR ?? join(repo, '..', 'moca-spec');
const source = join(spec, 'schemas/v1');
const vendored = join(repo, 'lib/schemas');
const names = new Set([...readdirSync(source), ...readdirSync(vendored)].filter((n) => n.endsWith('.schema.json')));
let failed = 0;
for (const name of [...names].sort()) {
  let a;
  let b;
  try {
    a = readFileSync(join(source, name));
    b = readFileSync(join(vendored, name));
  } catch {
    console.error(`FAIL ${name} exists in only one place`);
    failed++;
    continue;
  }
  if (!a.equals(b)) {
    console.error(`FAIL lib/schemas/${name} differs from moca-spec schemas/v1/${name}`);
    failed++;
  }
}
if (failed > 0) {
  console.error('Copy moca-spec schemas/v1/*.schema.json into lib/schemas/.');
  process.exitCode = 1;
} else {
  console.log(`${names.size} vendored schema(s) in sync.`);
}
