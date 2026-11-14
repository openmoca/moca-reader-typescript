// Vendored copies of schemas/v1/*.schema.json. scripts/check-vendored-schemas.mjs
// keeps them byte-identical to the normative files at the repository root.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
// Imported as JSON modules, not read from disk, so the Reader also runs where there is no file system
// (a Cloudflare Worker, a browser bundle).
import manifest from './schemas/manifest.schema.json' with { type: 'json' };
import node from './schemas/node.schema.json' with { type: 'json' };
import citationRecord from './schemas/citation-record.schema.json' with { type: 'json' };
import sidecarIndex from './schemas/sidecar-index.schema.json' with { type: 'json' };
import reviewPredicate from './schemas/review-predicate.schema.json' with { type: 'json' };
import trustRoot from './schemas/trust-root.schema.json' with { type: 'json' };
import searchHit from './schemas/search-hit.schema.json' with { type: 'json' };
import structure from './schemas/structure.schema.json' with { type: 'json' };
import mocaEnc from './schemas/moca-enc.schema.json' with { type: 'json' };

export const SCHEMAS = Object.freeze({ manifest, node, citationRecord, sidecarIndex, reviewPredicate, trustRoot, searchHit, structure, mocaEnc });

// Every validator is compiled here, when the module loads. A Cloudflare Worker allows code generation only then,
// not during a request, so a schema must never be compiled lazily.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const compiled = Object.fromEntries(Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)]));

/**
 * @param {keyof typeof SCHEMAS} name
 * @param {unknown} value
 * @returns {string[]} human-readable errors; empty when valid
 */
export function validateAgainst(name, value) {
  const validate = compiled[name];
  if (validate(value)) return [];
  const seen = new Set();
  const out = [];
  for (const err of validate.errors ?? []) {
    // oneOf/anyOf produce one error per branch; report the outer failure once.
    const where = err.instancePath || '(root)';
    const msg = `${where} ${err.message}${err.params?.allowedValues ? ` (${err.params.allowedValues.join(', ')})` : ''}`;
    if (!seen.has(msg)) {
      seen.add(msg);
      out.push(msg);
    }
  }
  return out;
}
