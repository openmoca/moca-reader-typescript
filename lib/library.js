// A library of loaded packages: citation records, relations between
// packages, and their merged structure with the host's overlays. Search over
// a library lives in search.js. See spec/moca-reader-contract.md §7-§10.
import { relationIndexOf } from './relations.js';
import { readFileSync } from 'node:fs';
import { citationFor, passesDefaultPolicy, pickRepresentation } from './citation.js';
import { Search } from './search.js';
import { LexicalBackend } from './backends/lexical.js';
import { StructureIndex } from './structure-ops.js';
import { parseStructure, LAYERS } from './structure.js';
import { Diagnostics } from './diagnostics.js';
import { DEFAULT_LIMITS } from './source.js';
import { audienceAllowed, recordAudience } from './audience.js';
import { libraryResolver } from './terms-gate.js';
import { gateReasons } from './terms.js';

export { citationFor, passesDefaultPolicy, pickRepresentation };

/**
 * @typedef {object} Overlay  host-supplied, never package content (moca-spec ADR-0008)
 * @property {string} id
 * @property {'application'|'organisation'} layer
 * @property {string|Buffer} [path]    a Turtle file
 * @property {string|Buffer} [source]  Turtle text
 *
 * @typedef {object} LibraryOptions
 * @property {() => Date} [clock]  defaults to the system clock
 * @property {Overlay[]} [overlays]
 * @property {Partial<typeof DEFAULT_LIMITS>} [limits]
 */

export class Library {
  /** @param {LibraryOptions} [options] */
  constructor({ clock = () => new Date(), overlays = [], limits, allowUnsignedRelations = false } = {}) {
    this.clock = clock;
    // Package spec §7.2: off by default. Only for libraries of the host's own packages.
    this.allowUnsignedRelations = allowUnsignedRelations;
    /** @type {Array<{ result: object, chunks: object[]|null, index: object|null }>} */
    this.packages = [];
    this.diagnostics = new Diagnostics();
    this.overlayFacts = [];
    const max = { ...DEFAULT_LIMITS, ...limits };
    for (const o of overlays) {
      if (!['application', 'organisation'].includes(o.layer)) throw new TypeError(`overlay ${o.id}: layer must be application or organisation`);
      const text = o.source ?? readFileSync(o.path);
      const parsed = parseStructure(text, { file: `overlay:${o.id}`, layer: o.layer, origin: `overlay:${o.id}`, diagnostics: this.diagnostics, limits: max });
      for (const f of parsed.facts) this.overlayFacts.push(f);
    }
    this.overlayFacts.sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer));
    this.structureIndex = null;
  }

  /** The merged structure of every loaded package and overlay (Reader contract §10). */
  get structure() {
    if (!this.structureIndex) this.structureIndex = new StructureIndex(this, this.overlayFacts);
    return this.structureIndex;
  }

  /**
   * The structure operations for a host that hands their answers to a model (Reader contract §10, "Under a terms
   * request"; moca-spec ADR-0041): the merged structure of the loaded packages that are not closed for the request,
   * and the overlays. A request with no `ai` part closes nothing, so it is the whole structure.
   *
   * @param {{ terms?: { ai?: object, rating?: object }, termsLimits?: object }} [options]
   */
  structureFor({ terms, termsLimits } = {}) {
    if (!terms || typeof terms !== 'object' || !terms.ai) return this.structure;
    const resolver = libraryResolver(this, { termsLimits, request: terms });
    const open = this.packages.filter(({ result }) => !resolver.closure(result.digest).closed);
    return new StructureIndex(this, this.overlayFacts, open);
  }

  /**
   * What a model may be told about the loaded packages (Reader contract §15.4, "The catalogue rule"; moca-spec
   * ADR-0041). A package has an entry only when one of its records, or of its members' at any depth, passes the
   * audience set and the default retrieval policy; when its own rating passes the request's rating gate; and when it
   * is not hidden. A closed package's entry has exactly id, version, title, publisher, signed and closedBy.
   *
   * @param {{ terms?: { ai?: object, rating?: object }, audiences?: string[], allowUnlabelled?: boolean, includeAll?: boolean, termsLimits?: object }} [options]
   * @returns {object[]} entries, valid against catalogue-entry.schema.json, ordered by id then version
   */
  catalogue({ terms, audiences, allowUnlabelled = false, includeAll = false, termsLimits } = {}) {
    const request = terms && typeof terms === 'object' ? terms : undefined;
    const resolver = libraryResolver(this, { termsLimits, request });
    const index = this.relationIndex();
    const now = this.clock();
    const audienceSet = audiences ? [...audiences] : undefined;
    const own = new Map();
    const passesOwn = (result) => {
      if (!own.has(result.digest)) {
        own.set(result.digest, result.nodes.some((node) => node.representations.some((rep) => {
          const r = citationFor(result, node, rep, { now, index });
          return (includeAll || passesDefaultPolicy(r)) && audienceAllowed(recordAudience(r), audienceSet, allowUnlabelled === true);
        })));
      }
      return own.get(result.digest);
    };
    // Its own records, or those of a member it composes, at any depth; each package walked once.
    const passes = (result) => {
      const seen = new Set();
      const queue = [result];
      while (queue.length > 0) {
        const r = queue.shift();
        if (seen.has(r.digest)) continue;
        seen.add(r.digest);
        if (passesOwn(r)) return true;
        for (const m of r.members ?? []) if (m.status === 'resolved' && m.result?.valid && m.result.digest) queue.push(m.result);
      }
      return false;
    };
    const byKey = (a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : a.manifest.version < b.manifest.version ? -1 : a.manifest.version > b.manifest.version ? 1 : 0);
    const listed = [];
    for (const result of this.packages.map((p) => p.result).sort(byKey)) {
      if (!passes(result)) continue;
      if (request?.rating !== undefined) {
        // The package's own rating, never a node's, as a record with that rating would be gated.
        const rating = result.terms?.declared?.rating;
        if (gateReasons({ rating: request.rating }, null, rating === undefined ? null : rating === null ? false : rating).length > 0) continue;
      }
      const closure = resolver.closure(result.digest);
      if (closure.hidden) continue;
      listed.push({ result, closure });
    }
    const present = new Set(listed.map(({ result }) => `${result.manifest.id}@${result.manifest.version}`));
    return listed.map(({ result, closure }) => {
      const m = result.manifest;
      const publisher = typeof result.publisher?.name === 'string' ? { publisher: result.publisher.name } : {};
      const signed = result.signers.length > 0;
      if (closure.closed) return { id: m.id, version: m.version, title: m.title, ...publisher, signed, closedBy: [...closure.closedBy] };
      return {
        id: m.id,
        version: m.version,
        title: m.title,
        ...(typeof m.description === 'string' ? { description: m.description } : {}),
        ...publisher,
        signed,
        ...(Array.isArray(result.tags) ? { tags: [...result.tags] } : {}),
        ...(Array.isArray(m.members) && m.members.length > 0
          ? { members: m.members.filter((x) => present.has(`${x?.id}@${x?.version}`)).map((x) => x.id) }
          : {}),
      };
    });
  }

  /**
   * Adds a package read by readPackage(). Invalid packages are refused.
   * @param {object} result
   * @param {{ chunks?: object[], index?: object }} [options]  from a bound sidecar (see bindSidecar)
   */
  add(result, { chunks, index } = {}) {
    if (!result.valid || !result.digest) throw new Error(`refusing to add an invalid package: ${result.manifest?.id ?? '(unknown)'}`);
    const key = (r) => `${r.manifest.id}@${r.manifest.version}`;
    const same = this.packages.find((p) => key(p.result) === key(result));
    if (same) {
      // Contract §7: one id@version, one digest. A second digest is refused and reported.
      if (same.result.digest !== result.digest) {
        // Package spec §13.5: a second issued copy of the same original is expected, and only noted.
        const original = same.result.issuedCopy?.originalDigest;
        if (original && original === result.issuedCopy?.originalDigest) {
          this.diagnostics.add('L002_ISSUED_COPY_DUPLICATE', `${key(result)} is already loaded as another issued copy of ${original}; ${result.digest} is not loaded`);
        } else {
          this.diagnostics.add('L001_IDENTITY_CONFLICT', `${key(result)} is already loaded with digest ${same.result.digest}; ${result.digest} is refused`);
        }
      }
      return this;
    }
    this.packages.push({ result, chunks: chunks ?? null, index: index ?? null });
    this.structureIndex = null;
    // A composed package brings its verified members with it.
    for (const member of result.members) {
      if (member.status === 'resolved' && member.result?.valid) this.add(member.result);
    }
    return this;
  }

  /** Package-level relation effects among the loaded packages (package spec §7.2). */
  relationIndex() {
    return relationIndexOf(this.packages.map((p) => ({
      id: p.result.manifest.id,
      version: p.result.manifest.version,
      relations: p.result.manifest.relations,
      relationScopes: p.result.relationScopes ?? [],
    })), { allowUnsignedRelations: this.allowUnsignedRelations });
  }

  /**
   * Citation records for every node (one per node, in the requested locale).
   * @param {{ locale?: string, includeText?: boolean }} [options]
   */
  citations({ locale, includeText = false } = {}) {
    const index = this.relationIndex();
    const now = this.clock();
    const out = [];
    for (const { result } of this.packages) {
      for (const node of result.nodes) {
        const rep = pickRepresentation(node, locale);
        out.push(citationFor(result, node, rep, { now, index, text: includeText ? rep.body : undefined }));
      }
    }
    return out;
  }

  /**
   * Lexical search over the loaded packages, or over sidecar chunks for a
   * package added with them. A synchronous shortcut for
   * `new Search(library, { backend: new LexicalBackend(library), audiences })`.
   *
   * @param {string} query
   * @param {{ limit?: number, includeAll?: boolean, audiences?: string[], locale?: string, concepts?: string[] }} [options]
   */
  search(query, { audiences, allowUnlabelled, ...options } = {}) {
    return new Search(this, { backend: new LexicalBackend(this), audiences, allowUnlabelled }).searchSync(query, options);
  }

  /**
   * Finds a node by its id (`<package id>#<path>`) or its versioned reference
   * (`<package id>@<version>#<path>`). An id matches the first loaded version.
   */
  get(nodeRef, { locale, includeText = true } = {}) {
    const hash = nodeRef.lastIndexOf('#');
    if (hash < 0) return null;
    const path = nodeRef.slice(hash + 1);
    const head = nodeRef.slice(0, hash);
    const index = this.relationIndex();
    for (const { result } of this.packages) {
      const { id, version } = result.manifest;
      if (head !== id && head !== `${id}@${version}`) continue;
      const node = result.nodes.find((n) => n.path === path);
      if (!node) continue;
      const rep = pickRepresentation(node, locale);
      return citationFor(result, node, rep, { now: this.clock(), index, text: includeText ? rep.body : undefined });
    }
    return null;
  }
}
