// Package spec §5.6 and Reader contract §9: binding by composition. A composing package's own structure may use a
// member's package id (at any depth) or a member's node identifier as a concept; the member's records are then bound
// to it, and to every concept that has it as a descendant, for the concepts and scope filters, upTo and nodes().
//
// Contract §3: the work stays roughly linear. A composition keeps only the direct bindings and the structure links
// above them; a search walks down once from the concepts it needs, rather than listing every record's ancestors.

import { chooseEdition } from './editions.js';

/** Plain JSON safe for any key, "__proto__" included. */
function record(entries) {
  const out = {};
  for (const [k, v] of entries) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const cache = new WeakMap();

/**
 * What a composing package's own structure binds its members to. One entry per resolved, valid, pin-matched member
 * at any depth, each member once whatever the paths to it (contract §3), with:
 * - `id`: its package id; `bound`: whether the composer's structure declares that id as a concept;
 * - `nodes`: the paths of its nodes whose identifiers the structure declares as concepts;
 * - `direct`: true when the composer lists it in its own `members` (it may also be composed by another member);
 * - `parents`: the members that compose it within this composition (none when the composer composes it directly).
 * `up` holds, for each concept on the way up from those declared identifiers, its broader concepts and the concepts
 * it is a part of, in the composer's own graph.
 * @param {object} result  a package result from readPackage
 * @returns {{ members: { digest: string, id: string, bound: boolean, nodes: string[], parents: string[] }[], up: Record<string, string[]> }|null}
 */
export function compositionOf(result) {
  if (result && typeof result === 'object' && cache.has(result)) return cache.get(result);
  const graph = result?.structure?.graph ?? null;
  const declared = (iri) => Boolean(graph?.concepts.get(iri)?.declared);
  const entries = new Map();
  const starts = [];
  const queue = [{ members: result?.members, parent: null }];
  const visited = new Set([result?.digest]);
  while (queue.length > 0) {
    const { members, parent } = queue.shift();
    for (const m of members ?? []) {
      const child = m.result;
      if (m.status !== 'resolved' || !child?.valid || !child.digest || child.digest === result?.digest) continue;
      let entry = entries.get(child.digest);
      if (!entry) {
        const id = child.manifest.id;
        const nodes = child.nodes.map((n) => n.path).filter((p) => declared(`${id}#${p}`)).sort();
        entry = { digest: child.digest, id, ...(typeof child.manifest.language === 'string' && child.manifest.language !== '' ? { language: child.manifest.language } : {}), ...(localesOf(child.manifest) ? { locales: localesOf(child.manifest) } : {}), bound: declared(id), nodes, parents: new Set() };
        entries.set(child.digest, entry);
        if (entry.bound) starts.push(id);
        for (const p of nodes) starts.push(`${id}#${p}`);
      }
      if (parent) entry.parents.add(parent);
      else entry.direct = true;
      if (!visited.has(child.digest)) {
        visited.add(child.digest);
        queue.push({ members: child.members, parent: child.digest });
      }
    }
  }
  // The links above each declared identifier, each concept walked once.
  const up = new Map();
  const stack = [...starts];
  while (stack.length > 0) {
    const n = stack.pop();
    if (up.has(n)) continue;
    // Package spec §7.4: an edition is bound to its slot as a part is.
    const parents = [...new Set([...graph.out('broader', n), ...graph.in('hasPart', n), ...graph.in('workExample', n)].map((e) => e.iri))].sort();
    up.set(n, parents);
    for (const p of parents) if (!up.has(p)) stack.push(p);
  }
  const out = entries.size === 0 ? null : {
    members: [...entries.values()]
      .sort((a, b) => (a.digest < b.digest ? -1 : 1))
      .map((e) => ({ digest: e.digest, id: e.id, ...(e.direct ? { direct: true } : {}), ...(e.language ? { language: e.language } : {}), ...(e.locales ? { locales: e.locales } : {}), bound: e.bound, nodes: e.nodes, parents: [...e.parents].sort() })),
    up: record([...up].filter(([, ps]) => ps.length > 0).sort(byKey)),
    // Package spec §7.4: the composite's own language, the slots' fallback after the default edition.
    ...(result.structure?.slots?.length > 0 && typeof result.manifest?.language === 'string' && result.manifest.language !== '' ? { language: result.manifest.language } : {}),
    // Package spec §7.4: the composite's edition groups.
    ...(result.structure?.slots?.length > 0 ? { slots: result.structure.slots.map((sl) => ({ iri: sl.iri, editions: [...sl.editions], ...(sl.default ? { default: sl.default } : {}) })) } : {}),
  };
  if (result && typeof result === 'object') cache.set(result, out);
  return out;
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** A manifest's `locales`, as strings, or undefined for none. */
function localesOf(manifest) {
  const l = strings(manifest?.locales);
  return l.length > 0 ? l : undefined;
}

/** One composer's bindings, from a result's compositionOf or a package state, read defensively. */
class Composer {
  constructor(digest, composition) {
    this.digest = digest;
    this.members = new Map();
    for (const m of Array.isArray(composition?.members) ? composition.members : []) {
      if (typeof m?.digest !== 'string' || typeof m.id !== 'string') continue;
      this.members.set(m.digest, { digest: m.digest, id: m.id, direct: m.direct === true, language: typeof m.language === 'string' ? m.language : undefined, locales: strings(m.locales), bound: m.bound === true, nodes: new Set(strings(m.nodes)), parents: strings(m.parents) });
    // Package spec §7.4: the composite's own language, for the fallback.
    this.language = typeof composition?.language === 'string' ? composition.language : undefined;
    }
    // Package spec §7.4: each slot, and its editions that resolved, matched their pin and are valid (direct members).
    this.slots = [];
    const direct = new Map();
    for (const m of this.members.values()) if (m.direct && !direct.has(m.id)) direct.set(m.id, m);
    for (const sl of Array.isArray(composition?.slots) ? composition.slots : []) {
      if (typeof sl?.iri !== 'string') continue;
      const editions = strings(sl.editions);
      const available = new Map(editions.filter((id) => direct.has(id)).map((id) => [id, { language: direct.get(id).language, locales: direct.get(id).locales, digest: direct.get(id).digest }]));
      this.slots.push({ iri: sl.iri, editions, ...(typeof sl.default === 'string' ? { default: sl.default } : {}), available });
    }
    this.children = new Map();
    const up = composition?.up && typeof composition.up === 'object' ? composition.up : {};
    for (const n of Object.keys(up)) {
      for (const p of strings(up[n])) {
        if (!this.children.has(p)) this.children.set(p, []);
        this.children.get(p).push(n);
      }
    }
    this.memberChildren = new Map();
    for (const m of this.members.values()) {
      for (const p of m.parents) {
        if (!this.memberChildren.has(p)) this.memberChildren.set(p, []);
        this.memberChildren.get(p).push(m.digest);
      }
    }
    this.hasBindings = [...this.members.values()].some((m) => m.bound || m.nodes.size > 0);
    this.reach = new WeakMap();
  }

  /**
   * For a set of concepts, what is bound to one of them or to a concept below one of them: the concepts at or below
   * them in this composer's links, and the members covered (a bound member id at or below them, and every member it
   * composes). Computed once per set.
   */
  #reached(wanted) {
    let r = this.reach.get(wanted);
    if (r) return r;
    const below = new Set(wanted);
    const stack = [...wanted];
    while (stack.length > 0) {
      for (const c of this.children.get(stack.pop()) ?? []) {
        if (!below.has(c)) {
          below.add(c);
          stack.push(c);
        }
      }
    }
    const covered = new Set();
    const queue = [...this.members.values()].filter((m) => m.bound && below.has(m.id)).map((m) => m.digest);
    while (queue.length > 0) {
      const d = queue.pop();
      if (covered.has(d)) continue;
      covered.add(d);
      for (const c of this.memberChildren.get(d) ?? []) queue.push(c);
    }
    r = { below, covered };
    this.reach.set(wanted, r);
    return r;
  }

  /** The member digests a member is under, itself included, at any depth in this composition. */
  under(digest) {
    const out = new Set();
    const stack = [digest];
    while (stack.length > 0) {
      const d = stack.pop();
      if (out.has(d) || !this.members.has(d)) continue;
      out.add(d);
      for (const p of this.members.get(d).parents) stack.push(p);
    }
    return out;
  }

  /**
   * Package spec §7.4 and contract §9.2 step 5.4: whether this composer's edition groups keep a record for a locale.
   * A record from one or more of a slot's editions (or their members) passes only when the slot's chosen edition is
   * one of them.
   */
  keepsEdition(rec, locale) {
    if (this.slots.length === 0) return true;
    const under = this.under(rec?.package?.digest);
    if (under.size === 0) return true;
    for (const slot of this.slots) {
      const holding = [...slot.available].filter(([, e]) => under.has(e.digest)).map(([id]) => id);
      if (holding.length === 0) continue;
      if (!holding.includes(chooseEdition(slot, slot.available, locale, this.language))) return false;
    }
    return true;
  }

  /**
   * Contract §3: the slots that hold a member's records, each with the ids of its editions the member is under,
   * indexed by edition digest so a record costs its own slots only. Computed once per member.
   */
  slotsFor(digest) {
    if (!this.byEdition) {
      this.byEdition = new Map();
      for (const slot of this.slots) {
        for (const [id, e] of slot.available) {
          if (!this.byEdition.has(e.digest)) this.byEdition.set(e.digest, []);
          this.byEdition.get(e.digest).push({ slot, id });
        }
      }
      this.slotCache = new Map();
    }
    let out = this.slotCache.get(digest);
    if (!out) {
      const bySlot = new Map();
      for (const d of this.under(digest)) {
        for (const { slot, id } of this.byEdition.get(d) ?? []) {
          if (!bySlot.has(slot)) bySlot.set(slot, []);
          bySlot.get(slot).push(id);
        }
      }
      out = [...bySlot].map(([slot, holding]) => ({ slot, holding }));
      this.slotCache.set(digest, out);
    }
    return out;
  }

  /** The members under an edition in this composition, the edition itself included. */
  membersUnder(digest) {
    this.underCache ??= new Map();
    if (!this.underCache.has(digest)) this.underCache.set(digest, [...this.members.keys()].filter((d) => this.under(d).has(digest)));
    return this.underCache.get(digest);
  }

  /** Whether this composer binds a record to a concept in `wanted` (a Set), directly or as an ancestor of its binding. */
  binds(rec, wanted) {
    const m = this.members.get(rec?.package?.digest);
    if (!m) return false;
    const { below, covered } = this.#reached(wanted);
    if (covered.has(m.digest)) return true;
    const path = rec?.node?.path;
    return typeof path === 'string' && m.nodes.has(path) && below.has(`${m.id}#${path}`);
  }
}

/**
 * An index of the loaded composing packages: for each member digest, the composers that hold it.
 * @param {{ digest: string, composition?: unknown }[]} composers  results (with compositionOf) or package states
 */
export class CompositionIndex {
  constructor(composers) {
    this.byMember = new Map();
    this.hasBindings = false;
    this.hasSlots = false;
    for (const c of composers) {
      if (typeof c?.digest !== 'string' || !c.composition || typeof c.composition !== 'object') continue;
      const composer = new Composer(c.digest, c.composition);
      if (composer.hasBindings) this.hasBindings = true;
      if (composer.slots.length > 0) this.hasSlots = true;
      for (const d of composer.members.keys()) {
        if (!this.byMember.has(d)) this.byMember.set(d, []);
        this.byMember.get(d).push(composer);
      }
    }
  }

  /** The composers that hold a member, each with `digest` and `binds(record, set)`. */
  composersOf(digest) {
    return this.byMember.get(digest) ?? [];
  }

  /** Whether a record is bound to a concept in `wanted` (a Set): by its node's own concepts, or by composition. */
  boundTo(rec, wanted) {
    if ((rec?.concepts ?? []).some((c) => wanted.has(c))) return true;
    return this.composersOf(rec?.package?.digest).some((k) => k.binds(rec, wanted));
  }
}
