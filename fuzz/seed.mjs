// Builds the fuzz seed corpora from moca-spec's conformance fixtures and example packages.
// <corpus dir>: every fixture archive as it is, and every fixture folder zipped (open-search.fuzz.js).
// <corpus dir>-files: each file of the `reading-order` fixture, with a last byte choosing which file it replaces
// (package-files.fuzz.js). Usage: node seed.mjs <moca-spec dir> <corpus dir>
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';

const [spec, out] = process.argv.slice(2);
if (!spec || !out) { console.error('usage: node fuzz/seed.mjs <moca-spec dir> <corpus dir>'); process.exit(2); }
mkdirSync(out, { recursive: true });
const MAX = 1024 * 1024; // keep seeds small, so each run explores more
let n = 0;
const save = (bytes, dir = out) => {
  if (bytes.length > MAX) return;
  writeFileSync(join(dir, createHash('sha256').update(bytes).digest('hex').slice(0, 16)), bytes);
  n++;
};
const walk = (dir, f) => { for (const e of readdirSync(dir)) { const p = join(dir, e); statSync(p).isDirectory() ? walk(p, f) : f(p); } };

const fixtures = join(spec, 'conformance', 'fixtures');
for (const e of readdirSync(fixtures)) {
  const p = join(fixtures, e);
  if (statSync(p).isDirectory()) {
    const zip = new AdmZip();
    walk(p, (f) => zip.addFile(relative(p, f).split('\\').join('/'), readFileSync(f)));
    save(zip.toBuffer());
  } else if (/\.(zip|moca)$/.test(e)) save(readFileSync(p));
}
const dist = join(spec, 'dist', 'examples');
try { for (const e of readdirSync(dist)) if (e.endsWith('.moca')) save(readFileSync(join(dist, e))); } catch { /* not built */ }

// Seeds for package-files.fuzz.js: the same file order as the target (sorted paths).
const base = join(fixtures, 'reading-order');
const files = [];
walk(base, (f) => files.push(relative(base, f).split('\\').join('/')));
files.sort();
mkdirSync(`${out}-files`, { recursive: true });
files.forEach((f, i) => save(Buffer.concat([readFileSync(join(base, f)), Buffer.from([i])]), `${out}-files`));
console.log(`${n} seed(s) in ${out} and ${out}-files`);
