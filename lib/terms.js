// Creators' terms (moca-spec package spec §4.14, Reader contract §15).
//
// Terms are labels, not locks. The Reader exposes them exactly as written, works out who stated them (the
// authority), and resolves and applies them only when the host asks: a search with a `terms` request. Nothing here
// fetches anything, configures the Reader, or changes what a read or a search without a terms request returns.
import { validatorFor } from './schemas.js';

/** The permission fields of `ai`, flattened. Each has an order from loosest to strictest. */
const FIELDS = {
  'allowed.device': [true, false],
  'allowed.host': [true, false],
  'allowed.provider': [true, false],
  'allowed.training': [true, false],
  'allowed.machineTranslation': [true, false],
  'allowed.mention': [true, false],
  answerSources: ['model', 'work'],
};
/** Contract §15.3: used only when no level sets a field. */
const PLATFORM = { 'allowed.device': true, 'allowed.host': true, 'allowed.provider': true, 'allowed.training': false, 'allowed.machineTranslation': true, 'allowed.mention': true, answerSources: 'model', providerRequires: [] };
/** Contract §15.3 (moca-spec ADR-0041): fields with no node level. In a `nodes` entry they are U003 and have no effect. */
const PACKAGE_ONLY = new Set(['allowed.mention']);
const KNOWN_CONDITIONS = new Set(['noTraining', 'noRetention']);
export const DESTINATIONS = ['device', 'host', 'provider'];
export const USES = ['answer', 'embed', 'summarise', 'train', 'translate'];

const fieldPath = (instancePath) => instancePath.split('/').filter(Boolean).join('.');

/**
 * Package spec §4.14: checks `terms` against the terms schema. Each problem is U003 (a string where only listed
 * strings are allowed, or a member name the schema does not list) or U001 (anything else, and the checks the
 * schema cannot express). Returns the problems, each `{ code, path, message }`.
 */
export function checkTerms(terms) {
  if (terms === undefined) return [];
  const problems = [];
  const seen = new Set();
  const add = (code, path, message) => {
    const key = `${code} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ code, path, message });
  };
  const errors = validateTermsRaw(terms);
  // A failed oneOf/anyOf reports its branches too; the keyword errors at the deepest paths are what is wrong.
  for (const e of errors) {
    if (e.keyword === 'oneOf' || e.keyword === 'anyOf' || e.keyword === 'if') continue;
    const base = fieldPath(e.instancePath);
    if (e.keyword === 'enum' && typeof valueAt(terms, e.instancePath) === 'string') {
      add('U003_TERMS_UNKNOWN_VALUE', base, `${base} has a value this version does not know: ${JSON.stringify(valueAt(terms, e.instancePath))}`);
    } else if (e.keyword === 'additionalProperties') {
      const path = base ? `${base}.${e.params.additionalProperty}` : e.params.additionalProperty;
      add('U003_TERMS_UNKNOWN_VALUE', path, `${path} is a member this version does not know`);
    } else {
      add('U001_TERMS_INVALID', base || '(terms)', `${base || 'terms'} ${e.message}`);
    }
  }
  const ratings = [['rating', terms?.rating], ...(Array.isArray(terms?.nodes) ? terms.nodes.map((n, i) => [`nodes.${i}.rating`, n?.rating]) : [])];
  for (const [at, r] of ratings) {
    const range = typeof r?.typicalAgeRange === 'string' ? /^([0-9]{1,2})-([0-9]{1,2})?$/.exec(r.typicalAgeRange) : null;
    if (range && range[2] !== undefined && Number(range[1]) > Number(range[2])) add('U001_TERMS_INVALID', `${at}.typicalAgeRange`, `${at}.typicalAgeRange has its lower bound above its upper`);
    if (Array.isArray(r?.contentRating)) {
      const schemes = r.contentRating.map((x) => x?.scheme).filter((x) => typeof x === 'string');
      if (new Set(schemes).size !== schemes.length) add('U001_TERMS_INVALID', `${at}.contentRating`, `${at}.contentRating has two entries for one scheme`);
    }
  }
  // A copyright year range must not end before it starts.
  const copyrights = [['rights.copyright', terms?.rights?.copyright], ...(Array.isArray(terms?.nodes) ? terms.nodes.map((n, i) => [`nodes.${i}.rights.copyright`, n?.rights?.copyright]) : [])];
  for (const [at, c] of copyrights) {
    const years = typeof c?.year === 'string' ? /^([0-9]{4})-([0-9]{4})$/.exec(c.year) : null;
    if (years && Number(years[1]) > Number(years[2])) add('U001_TERMS_INVALID', `${at}.year`, `${at}.year has its first year after its last`);
  }
  return problems;
}

function validateTermsRaw(terms) {
  const validate = termsValidator();
  return validate(terms) ? [] : (validate.errors ?? []);
}

// Compiled when schemas.js loads (a Cloudflare Worker allows code generation only then).
const termsValidator = () => validatorFor('terms');

function valueAt(obj, pointer) {
  return pointer.split('/').filter(Boolean).reduce((v, k) => (v && typeof v === 'object' ? v[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), obj);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Stands for a value under a container that is present and malformed: never a known value, so the strictest. */
const MALFORMED = Symbol('malformed');

/**
 * The value of a flattened field in an `ai` object, or undefined when nothing sets it. Contract §15.3: a container
 * (`ai`, `ai.allowed`) that is present and not an object makes every permission under it the strictest.
 */
function aiValue(ai, field) {
  if (ai === undefined) return undefined;
  if (!isObject(ai)) return MALFORMED;
  if (field.startsWith('allowed.')) {
    if (ai.allowed === undefined) return undefined;
    return isObject(ai.allowed) ? ai.allowed[field.slice(8)] : MALFORMED;
  }
  return ai[field];
}

/** A value a level sets, as one of the field's known values: a malformed or unknown value counts as the strictest. */
function normalise(field, value) {
  if (value === undefined) return undefined;
  const order = FIELDS[field];
  return order.includes(value) ? value : order[order.length - 1];
}

/** The conditions a level sets; an unknown or malformed one is kept, so no host can meet it (the strictest). */
function conditionsOf(ai) {
  if (ai === undefined) return undefined;
  if (!isObject(ai)) return ['(malformed)'];
  if (ai.providerRequires === undefined) return undefined;
  if (!Array.isArray(ai.providerRequires)) return ['(malformed)'];
  return ai.providerRequires.map((c) => (typeof c === 'string' && KNOWN_CONDITIONS.has(c) ? c : `(unknown:${String(c)})`));
}

const stricter = (field, a, b) => FIELDS[field].indexOf(a) > FIELDS[field].indexOf(b);

/**
 * Contract §15.3 step 2, reported when the package is read: a `nodes` entry whose `ai` value is looser than the
 * package's own. Returns one finding per entry and field.
 */
export function loosenedNodes(terms) {
  const out = [];
  if (!Array.isArray(terms?.nodes)) return out;
  terms.nodes.forEach((entry, i) => {
    for (const field of Object.keys(FIELDS)) {
      if (PACKAGE_ONLY.has(field)) continue;
      const pkg = normalise(field, aiValue(terms.ai, field));
      const node = normalise(field, aiValue(entry?.ai, field));
      if (pkg !== undefined && node !== undefined && stricter(field, pkg, node)) out.push({ path: `nodes.${i}.ai.${field}`, message: `nodes[${i}] sets ${field} ${node}, looser than the package's ${pkg}; the package's value stands` });
    }
    const pc = conditionsOf(terms.ai);
    const nc = conditionsOf(entry?.ai);
    if (pc && nc && pc.some((c) => !nc.includes(c))) out.push({ path: `nodes.${i}.ai.providerRequires`, message: `nodes[${i}] drops provider conditions the package sets; the package's stand` });
  });
  return out;
}

/**
 * Contract §15.2: the authority for a package's terms, from its valid package attestations, never from fields the
 * signer writes: `packager` when one verifies under the host's trust root, otherwise `unverified`.
 *
 * @param {object[]} signers  the signers of the package's valid package attestations
 */
export function authorityOf(signers) {
  return signers.length > 0 ? 'packager' : 'unverified';
}

/** The entry every node gets when `nodes`, or one of its entries, cannot be read: everything at its strictest. */
const STRICTEST_ENTRY = Object.freeze({ ai: null, rating: false });

const wellFormedEntry = (entry) => isObject(entry) && Array.isArray(entry.paths) && entry.paths.every((p) => typeof p === 'string');

/**
 * The `nodes` entry that applies to a node path: the longest matching path or `/`-ended prefix (package spec §4.14).
 * Contract §15.3: a `nodes` that is present and not a list, an entry that is not an object, and an entry whose
 * `paths` is not a list of strings do not say which nodes they mean, so they count for every node, at the strictest.
 */
export function nodeEntry(terms, path) {
  if (terms?.nodes === undefined) return null;
  if (!Array.isArray(terms.nodes) || !terms.nodes.every(wellFormedEntry)) return STRICTEST_ENTRY;
  const full = `content/${path}`;
  let best = null;
  let bestLength = -1;
  for (const entry of terms.nodes) {
    for (const p of entry.paths) {
      const hit = p.endsWith('/') ? full.startsWith(p) : full === p;
      if (hit && p.length > bestLength) {
        best = entry;
        bestLength = p.length;
      }
    }
  }
  return best;
}

/**
 * Contract §15.3: the resolved `ai` terms for one node. Each field `{ value, decidedBy }`; `providerRequires` is a
 * list of conditions.
 *
 * @param {{ terms?: object, authority: string }} pkg
 * @param {string|null} path  the node path under content/; null for the package-level terms, with no node level
 *   (contract §15.4, "Closed and hidden")
 * @param {object} [limits]  the host's terms limits (an `ai` object): floors, never values
 * @param {object[]} [composites]  the `terms` of composing packages whose signers speak for this package (step 3)
 */
export function resolveAi(pkg, path, limits, composites = []) {
  const terms = pkg.terms ?? {};
  const out = {};
  const node = path === null ? null : nodeEntry(terms, path);
  for (const field of Object.keys(FIELDS)) {
    let value = PLATFORM[field];
    let decidedBy = 'platform';
    // Each level applies only if it is stricter: no authority in this version lets a package loosen the platform.
    const apply = (v, level) => {
      const n = normalise(field, v);
      if (n === undefined) return;
      if (stricter(field, n, value) || n === value) {
        value = n;
        decidedBy = level;
      }
    };
    apply(aiValue(terms.ai, field), 'package');
    // A package-level field has no node level, even under a malformed entry (contract §15.3).
    if (!PACKAGE_ONLY.has(field)) apply(aiValue(node?.ai, field), 'node');
    for (const c of composites) apply(aiValue(c?.ai, field), 'composite');
    apply(aiValue(limits, field), 'host');
    out[field] = { value, decidedBy };
  }
  let conditions = [];
  let decidedBy = 'platform';
  const levels = [[terms.ai, 'package'], [node?.ai, 'node'], ...composites.map((c) => [c?.ai, 'composite']), [limits, 'host']];
  for (const [ai, level] of levels) {
    const c = conditionsOf(ai);
    if (c === undefined) continue;
    const merged = [...new Set([...conditions, ...c])];
    if (merged.length > conditions.length) decidedBy = level;
    conditions = merged;
  }
  out.providerRequires = { value: conditions.sort(), decidedBy };
  return out;
}

/**
 * The node's effective rating as written: its own `nodes` entry's, if any, else the package's (contract §15.3);
 * null when neither sets one. A value that is present and not an object is returned as it is: the gate counts it as
 * the strictest rating.
 */
export function ratingOf(terms, path) {
  const node = nodeEntry(terms, path);
  const own = node && node.rating !== undefined ? node.rating : terms?.rating;
  return own === undefined ? null : own === null ? false : own;
}

/** The destination a request names; an unknown or missing one is treated as the strictest, provider. */
const destinationOf = (request) => (DESTINATIONS.includes(request?.destination) ? request.destination : 'provider');

/**
 * Contract §15.4, "Closed and hidden": whether a package is closed for a request's `ai` part, from its package-level
 * resolved terms (no node level), and whether it is hidden. A use never closes a package.
 *
 * @param {{ ai?: { destination?: string, conditions?: string[] } }|undefined} request
 * @param {object} ai  the package-level resolved terms (resolveAi with a null path)
 * @returns {{ closed: boolean, closedBy: string[], hidden: boolean }}
 */
export function closureOf(request, ai) {
  if (!request?.ai || typeof request.ai !== 'object') return { closed: false, closedBy: [], hidden: false };
  const destination = destinationOf(request.ai);
  const conditions = new Set(Array.isArray(request.ai.conditions) ? request.ai.conditions : []);
  const closedBy = [];
  if (ai[`allowed.${destination}`].value !== true) closedBy.push(`ai.allowed.${destination}`);
  else if (destination === 'provider' && ai.providerRequires.value.some((c) => !conditions.has(c))) closedBy.push('ai.providerRequires');
  const closed = closedBy.length > 0;
  return { closed, closedBy, hidden: closed && ai['allowed.mention'].value !== true };
}

/** The members of a rating request this version defines (contract §15.4). */
const RATING_REQUEST = new Set(['explicit', 'schemes', 'allowUnrated', 'acceptFeedRatings']);

/**
 * Contract §15.4: the reasons the terms gate removes a record, or an empty list. `ai` is the node's resolved terms.
 *
 * @param {{ ai?: { destination?: string, conditions?: string[], use?: string }, rating?: object }} request
 */
export function gateReasons(request, ai, rating) {
  const reasons = [];
  if (request.ai) {
    // An unknown or missing destination is treated as the strictest, provider.
    const destination = destinationOf(request.ai);
    const conditions = new Set(Array.isArray(request.ai.conditions) ? request.ai.conditions : []);
    if (ai[`allowed.${destination}`].value !== true) reasons.push(`ai.allowed.${destination}`);
    else if (destination === 'provider' && ai.providerRequires.value.some((c) => !conditions.has(c))) reasons.push('ai.providerRequires');
    if (request.ai.use === 'train' && ai['allowed.training'].value !== true) reasons.push('ai.allowed.training');
    if (request.ai.use === 'translate' && ai['allowed.machineTranslation'].value !== true) reasons.push('ai.allowed.machineTranslation');
  }
  if (request.rating !== undefined) {
    const r = request.rating;
    // A request this version cannot honour in full is never run as a weaker one: it removes every record.
    if (!isObject(r) || Object.keys(r).some((k) => !RATING_REQUEST.has(k)) || (r.schemes !== undefined && !isObject(r.schemes))) {
      reasons.push('rating.request');
      return reasons;
    }
    // A rating that is present and malformed counts as the strictest: explicit, and outside every listed scheme.
    const malformed = rating !== null && !isObject(rating);
    const fromFeed = !malformed && rating?.declaredBy === 'feed';
    let explicit;
    if (malformed) explicit = true;
    else if (rating && rating.explicit !== undefined) {
      explicit = typeof rating.explicit === 'boolean' ? rating.explicit : true;
      // A feed's `explicit: false` counts only when the host accepts feed ratings; otherwise it is unrated.
      if (fromFeed && explicit === false && r.acceptFeedRatings !== true) explicit = undefined;
    }
    const entries = malformed || !rating || rating.contentRating === undefined ? [] : rating.contentRating;
    const unreadable = malformed || !Array.isArray(entries) || entries.some((x) => !isObject(x) || typeof x.scheme !== 'string');
    // Only the schemes the host listed count: a rating under any other scheme says nothing to this filter.
    const listed = Object.entries(r.schemes ?? {}).filter(([scheme]) => unreadable || entries.some((x) => x.scheme === scheme));
    if (explicit === undefined && listed.length === 0) {
      if (r.allowUnrated !== true) reasons.push('rating.unrated');
    } else {
      if (r.explicit === false && explicit === true) reasons.push('rating.explicit');
      for (const [scheme, allowed] of listed) {
        const entry = unreadable ? undefined : entries.find((x) => x.scheme === scheme);
        if (!entry || !Array.isArray(allowed) || !allowed.includes(entry.value)) reasons.push(`rating.${scheme}`);
      }
    }
  }
  return reasons;
}

/**
 * Contract §15.3: the resolved export permission (`rights.export.allowed`). Only the package (and a composing package
 * whose signers speak for the member) sets it; the platform default is true, and a malformed value counts as false.
 */
export function resolveExport(pkg, composites = []) {
  let value = true;
  let decidedBy = 'platform';
  // Each level applies only if it is as strict or stricter; a malformed value counts as false.
  const apply = (terms, level) => {
    // A `rights` or `rights.export` that is present and not an object counts as the strictest: not allowed.
    const rights = terms?.rights;
    const v = rights === undefined ? undefined
      : !isObject(rights) ? MALFORMED
        : rights.export === undefined ? undefined
          : isObject(rights.export) ? rights.export.allowed : MALFORMED;
    if (v === undefined) return;
    const n = v === true;
    if (!n || value) {
      value = n;
      decidedBy = level;
    }
  };
  apply(pkg.terms, 'package');
  for (const c of composites) apply(c, 'composite');
  return { value, decidedBy };
}

/** Is a terms field usable: no problem at its path or under it (contract §7)? */
const clean = (problems, path) => !(problems ?? []).some((p) => p.path === path || p.path.startsWith(`${path}.`));

/**
 * Contract §7: a node's licence and copyright statement. The node's `terms.nodes` entry first, else the package's
 * (`license` from the manifest, `terms.rights.copyright`); a value with a terms problem at or under its path is skipped.
 *
 * @param {object|undefined} terms  the declared terms
 * @param {object[]} problems  the terms problems ({ code, path })
 * @param {string|undefined} license  the manifest's license, when the manifest passes its schema
 * @param {string} path  the node path under content/
 */
export function rightsOf(terms, problems, license, path) {
  const entry = nodeEntry(terms, path);
  const at = entry && entry !== STRICTEST_ENTRY ? `nodes.${terms.nodes.indexOf(entry)}.rights` : null;
  const out = {};
  if (at && typeof entry.rights?.license === 'string' && clean(problems, `${at}.license`)) out.license = entry.rights.license;
  else if (typeof license === 'string') out.license = license;
  if (at && entry.rights?.copyright && typeof entry.rights.copyright === 'object' && clean(problems, `${at}.copyright`)) out.copyright = structuredClone(entry.rights.copyright);
  else if (terms?.rights?.copyright && typeof terms.rights.copyright === 'object' && clean(problems, 'rights.copyright')) out.copyright = structuredClone(terms.rights.copyright);
  return out;
}

/** The `terms` field of a citation record from a search with a terms request (citation-record schema). */
export function recordTerms(authority, ai, rating, exportPermission) {
  const nested = { allowed: {} };
  for (const [k, v] of Object.entries(ai)) {
    if (k.startsWith('allowed.')) nested.allowed[k.slice(8)] = v;
    else nested[k] = v;
  }
  // A rating that is present and not an object is shown as what it counts as: explicit.
  const shown = rating === null || rating === undefined ? null : isObject(rating) ? rating : { explicit: true };
  return { authority, ai: nested, ...(shown ? { rating: shown } : {}), ...(exportPermission ? { rights: { export: exportPermission } } : {}) };
}
