// Package-level relation effects (package spec §7.2) over a set of packages:
// loaded results in a Library, or package states for a store search (§9.4).
import { scopeCovers } from './attestations.js';

/**
 * @param {Array<{ id: string, version: string, relations?: object[], relationScopes?: string[] }>} packages
 * @param {{ allowUnsignedRelations?: boolean }} [options]
 * @returns {{ superseded: Map<string, string[]>, contested: Map<string, string[]> }}
 */
export function relationIndexOf(packages, { allowUnsignedRelations = false } = {}) {
  const superseded = new Map();
  const contested = new Map();
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(value)) map.get(key).push(value);
  };
  for (const m of packages) {
    for (const r of Array.isArray(m.relations) ? m.relations : []) {
      // Only relations a signer of the package may make take effect.
      if (!allowUnsignedRelations && !scopeCovers(m.relationScopes ?? [], r?.target)) continue;
      for (const t of packages.filter((x) => x.id === r.target && (!r.version || x.version === r.version))) {
        const key = `${t.id}@${t.version}`;
        const self = `${m.id}@${m.version}`;
        if (r.type === 'supersedes') push(superseded, key, self);
        if (r.type === 'conflictsWith') {
          push(contested, key, self);
          push(contested, self, key);
        }
      }
    }
  }
  return { superseded, contested };
}
