// Edition groups: package spec §7.4 and Reader contract §9.2 step 5.4, §10.
//
// A slot is a concept in a composite package's own structure.ttl with schema:workExample values, each the id of one
// of the composite's own members (an edition), and at most one moca:defaultEdition.
import { lookup } from './locale.js';

export const SCHEMA_WORK_EXAMPLE = 'https://schema.org/workExample';
export const MOCA_DEFAULT_EDITION = 'https://w3id.org/moca/ns#defaultEdition';

/**
 * The valid slots of a composite's own structure, with O006 for each ignored statement.
 * @param {import('./structure.js').StructureGraph} graph  the package's own graph
 * @param {string[]} memberIds  the ids in the manifest's own `members`
 * @returns {{ iri: string, editions: string[], default?: string }[]}  ordered by IRI
 */
export function readSlots(graph, memberIds, diagnostics, file) {
  const members = new Set(memberIds);
  const slots = new Map();
  for (const s of [...graph.edges.workExample.keys()].sort()) {
    const editions = [];
    for (const { iri } of graph.out('workExample', s)) {
      if (members.has(iri)) editions.push(iri);
      else diagnostics.add('O006_EDITION_GROUP_INVALID', `${s} has schema:workExample ${iri}, which is not the id of one of this package's members; it is ignored`, { file });
    }
    if (editions.length > 0) slots.set(s, { iri: s, editions });
  }
  for (const s of [...graph.edges.defaultEdition.keys()].sort()) {
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
 * Package spec §7.4, "Choosing": the edition a slot chooses for a locale, among the editions that can be chosen.
 * @param {{ editions: string[], default?: string }} slot
 * @param {Map<string, { language?: string }>} available  edition id -> what is known of it, only those that can be chosen
 * @param {string|string[]|undefined} locale
 * @returns {string|undefined}
 */
export function chooseEdition(slot, available, locale) {
  const ids = slot.editions.filter((id) => available.has(id)).sort();
  if (ids.length === 0) return undefined;
  const byLanguage = lookup(ids.map((id) => ({ tag: available.get(id).language, value: id })), locale);
  if (byLanguage) return byLanguage;
  if (slot.default && available.has(slot.default)) return slot.default;
  return ids[0];
}
