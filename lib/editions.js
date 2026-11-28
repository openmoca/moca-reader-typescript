// Edition groups: package spec §7.4 and Reader contract §9.2 step 5.4, §10.
//
// A slot is a concept in a composite package's own structure.ttl with schema:workExample values, each the id of one
// of the composite's own members (an edition), and at most one moca:defaultEdition.
import { lookup } from './locale.js';

export const SCHEMA_WORK_EXAMPLE = 'https://schema.org/workExample';
export const MOCA_DEFAULT_EDITION = 'https://w3id.org/moca/ns#defaultEdition';

/**
 * Package spec §7.4, "A slot": a slot belongs to the composite that declares it, so its IRI is in the composite's own
 * namespace: its `id` followed by `#` or `/`.
 */
export function ownsSlot(id, iri) {
  return typeof id === 'string' && id !== '' && typeof iri === 'string' && (iri.startsWith(`${id}#`) || iri.startsWith(`${id}/`));
}

/**
 * The valid slots of a composite's own structure, with O006 for each ignored statement.
 * @param {import('./structure.js').StructureGraph} graph  the package's own graph
 * @param {string[]} memberIds  the ids in the manifest's own `members`
 * @param {string} [ownId]  the composite's own `id`: a slot outside its namespace is not read
 * @returns {{ iri: string, editions: string[], default?: string }[]}  ordered by IRI
 */
export function readSlots(graph, memberIds, diagnostics, file, ownId) {
  const members = new Set(memberIds);
  const slots = new Map();
  const foreign = new Set();
  for (const s of [...graph.edges.workExample.keys()].sort()) {
    if (!ownsSlot(ownId, s)) {
      foreign.add(s);
      diagnostics.add('O006_EDITION_GROUP_INVALID', `${s} is not in this package's own namespace (${ownId}# or ${ownId}/), so it is not read as a slot`, { file });
      continue;
    }
    const editions = [];
    for (const { iri } of graph.out('workExample', s)) {
      if (members.has(iri)) editions.push(iri);
      else diagnostics.add('O006_EDITION_GROUP_INVALID', `${s} has schema:workExample ${iri}, which is not the id of one of this package's members; it is ignored`, { file });
    }
    if (editions.length > 0) slots.set(s, { iri: s, editions });
  }
  for (const s of [...graph.edges.defaultEdition.keys()].sort()) {
    if (foreign.has(s)) continue;
    const named = graph.out('defaultEdition', s).map((e) => e.iri);
    const slot = slots.get(s);
    if (named.length > 1) {
      diagnostics.add('O006_EDITION_GROUP_INVALID', `${s} names ${named.length} default editions; none is used`, { file });
      continue;
    }
    if (!slot || !slot.editions.includes(named[0])) {
      diagnostics.add('O006_EDITION_GROUP_INVALID', `${s} has moca:defaultEdition ${named[0]}, which is not one of its editions; it is ignored`, { file });
      continue;
    }
    slot.default = named[0];
  }
  return [...slots.values()];
}

/**
 * Package spec §7.4, "Choosing": the edition a slot chooses for a locale, among the editions that can be chosen. Each
 * edition is tagged with its manifest `language` and each of its `locales`. With no match: the default edition; else
 * the edition the composite's own language finds by the same lookup; else the lowest id.
 * @param {{ editions: string[], default?: string }} slot
 * @param {Map<string, { language?: string, locales?: string[] }>} available  edition id -> what is known of it, only
 *   those that can be chosen
 * @param {string|string[]|undefined} locale
 * @param {string} [compositeLanguage]  the composite's manifest `language`
 * @returns {string|undefined}
 */
export function chooseEdition(slot, available, locale, compositeLanguage) {
  const ids = slot.editions.filter((id) => available.has(id)).sort();
  if (ids.length === 0) return undefined;
  const tagged = ids.flatMap((id) => {
    const e = available.get(id);
    return [e.language, ...(Array.isArray(e.locales) ? e.locales : [])].filter((t) => typeof t === 'string' && t !== '').map((tag) => ({ tag, value: id }));
  });
  const byLanguage = lookup(tagged, locale);
  if (byLanguage) return byLanguage;
  if (slot.default && available.has(slot.default)) return slot.default;
  const byComposite = typeof compositeLanguage === 'string' && compositeLanguage !== '' ? lookup(tagged, compositeLanguage) : undefined;
  return byComposite ?? ids[0];
}

/** SemVer 2.0.0 precedence (§11) of two versions as package spec §4.3 writes them; build metadata is ignored. */
export function compareSemver(a, b) {
  const split = (v) => {
    const [core, ...pre] = String(v).split('+')[0].split('-');
    return { core: core.split('.'), pre: pre.length > 0 ? pre.join('-').split('.') : null };
  };
  const num = (x, y) => (x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0);
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i += 1) {
    const c = num(x.core[i] ?? '0', y.core[i] ?? '0');
    if (c !== 0) return Math.sign(c);
  }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const xn = /^[0-9]+$/.test(x.pre[i]);
    const yn = /^[0-9]+$/.test(y.pre[i]);
    const c = xn && yn ? num(x.pre[i], y.pre[i]) : xn ? -1 : yn ? 1 : x.pre[i] < y.pre[i] ? -1 : x.pre[i] > y.pre[i] ? 1 : 0;
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}
