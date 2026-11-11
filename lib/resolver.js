// A simple host resolver for members: looks for packages in a list of
// directories. Hosts with a registry supply their own resolver instead.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Returns a resolveMember() function that finds `{ id, version }` among the
 * package directories directly inside (or equal to) each search directory.
 *
 * @param {string[]} dirs
 */
export function directoryResolver(dirs) {
  const candidates = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const roots = [dir, ...readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory())];
    for (const root of roots) {
      const manifestPath = join(root, 'moca.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
        candidates.push({ id: m.id, version: m.version, root });
      } catch {
        // an unreadable manifest is not a candidate
      }
    }
  }
  return ({ id, version }) => candidates.find((c) => c.id === id && c.version === version)?.root ?? null;
}
