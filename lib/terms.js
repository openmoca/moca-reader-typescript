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
  answerSources: ['model', 'work'],
};
/** Contract §15.3: used only when no level sets a field. */
const PLATFORM = { 'allowed.device': true, 'allowed.host': true, 'allowed.provider': true, 'allowed.training': false, 'allowed.machineTranslation': true, answerSources: 'model', providerRequires: [] };
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

/** The value of a flattened field in an `ai` object, or undefined. */
function aiValue(ai, field) {
  if (!ai || typeof ai !== 'object') return undefined;
  if (field.startsWith('allowed.')) return ai.allowed && typeof ai.allowed === 'object' ? ai.allowed[field.slice(8)] : undefined;
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
  if (!ai || typeof ai !== 'object' || ai.providerRequires === undefined) return undefined;
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

/** The `nodes` entry that applies to a node path: the longest matching path or `/`-ended prefix (package spec §4.14). */
export function nodeEntry(terms, path) {
  if (!Array.isArray(terms?.nodes)) return null;
  const full = `content/${path}`;
  let best = null;
  let bestLength = -1;
  for (const entry of terms.nodes) {
    for (const p of Array.isArray(entry?.paths) ? entry.paths : []) {
      if (typeof p !== 'string') continue;
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
 * @param {string} path  the node path under content/
 * @param {object} [limits]  the host's terms limits (an `ai` object): floors, never values
 */
export function resolveAi(pkg, path, limits) {
  const terms = pkg.terms ?? {};
  const out = {};
  const node = nodeEntry(terms, path);
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
    apply(aiValue(node?.ai, field), 'node');
    apply(aiValue(limits, field), 'host');
    out[field] = { value, decidedBy };
  }
  let conditions = [];
  let decidedBy = 'platform';
  const levels = [[terms.ai, 'package'], [node?.ai, 'node'], [limits, 'host']];
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

/** The node's effective rating: its own `nodes` entry's, if any, else the package's (contract §15.3). */
export function ratingOf(terms, path) {
  const node = nodeEntry(terms, path);
  if (node?.rating && typeof node.rating === 'object') return node.rating;
  return terms?.rating && typeof terms.rating === 'object' ? terms.rating : null;
}

/**
 * Contract §15.4: the reasons the terms gate removes a record, or an empty list. `ai` is the node's resolved terms.
 *
 * @param {{ ai?: { destination?: string, conditions?: string[], use?: string }, rating?: object }} request
 */
export function gateReasons(request, ai, rating) {
  const reasons = [];
  if (request.ai) {
    // An unknown or missing destination is treated as the strictest, provider.
    const destination = DESTINATIONS.includes(request.ai.destination) ? request.ai.destination : 'provider';
    const conditions = new Set(Array.isArray(request.ai.conditions) ? request.ai.conditions : []);
    if (ai[`allowed.${destination}`].value !== true) reasons.push(`ai.allowed.${destination}`);
    else if (destination === 'provider' && ai.providerRequires.value.some((c) => !conditions.has(c))) reasons.push('ai.providerRequires');
    if (request.ai.use === 'train' && ai['allowed.training'].value !== true) reasons.push('ai.allowed.training');
    if (request.ai.use === 'translate' && ai['allowed.machineTranslation'].value !== true) reasons.push('ai.allowed.machineTranslation');
  }
  if (request.rating) {
    const r = request.rating;
    const fromFeed = rating?.declaredBy === 'feed';
    // A feed's `explicit: false` counts only when the host accepts feed ratings; otherwise it is unrated.
    const explicit = rating && typeof rating.explicit === 'boolean' && !(fromFeed && rating.explicit === false && r.acceptFeedRatings !== true) ? rating.explicit : undefined;
    const schemes = Array.isArray(rating?.contentRating) ? rating.contentRating : [];
    const rated = explicit !== undefined || schemes.length > 0;
    if (!rated) {
      if (r.allowUnrated !== true) reasons.push('rating.unrated');
    } else {
      if (r.explicit === false && explicit === true) reasons.push('rating.explicit');
      for (const [scheme, allowed] of Object.entries(r.schemes ?? {})) {
        const entry = schemes.find((x) => x?.scheme === scheme);
        if (entry && Array.isArray(allowed) && !allowed.includes(entry.value)) reasons.push(`rating.${scheme}`);
      }
    }
  }
  return reasons;
}

/** The `terms` field of a citation record from a search with a terms request (citation-record schema). */
export function recordTerms(authority, ai, rating) {
  const nested = { allowed: {} };
  for (const [k, v] of Object.entries(ai)) {
    if (k.startsWith('allowed.')) nested.allowed[k.slice(8)] = v;
    else nested[k] = v;
  }
  return { authority, ai: nested, ...(rating ? { rating } : {}) };
}
