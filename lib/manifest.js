// Manifest checks beyond the JSON Schema. See spec/moca-package-spec.md §4.
import { parseInstant } from './dates.js';
import { validateAgainst } from './schemas.js';

export const MANIFEST_KEYS = new Set([
  '$schema', 'mocaVersion', 'id', 'version', 'title', 'description', 'language', 'locales', 'license',
  'publisher', 'distribution', 'images', 'translations', 'tags', 'apps', 'validFrom', 'validUntil', 'members', 'relations',
  'profiles',
]);

// URN namespaces registered with IANA that are commonly used as package ids.
// Package spec §4.2: the IANA formal URN namespaces, as in moca-spec data/urn-namespaces.json
// (a test keeps them equal). Informal namespaces, urn-<number>, are registered too.
export const REGISTERED_URN_NIDS = new Set([
  '3gpp', '3gpp2', 'adid', 'alert', 'bbf', 'broadband-forum-org', 'c2pa', 'cablelabs', 'ccsds', 'cdx', 'cgi', 'clei',
  'csa', 'cta', 'ddi', 'dev', 'dgiwg', 'dnp', 'doi', 'dslforum-org', 'dvb', 'ebu', 'eic', 'eidr', 'epc', 'epcglobal',
  'etsi', 'eurosystem', 'example', 'fdc', 'fipa', 'gdr', 'gdst', 'geant', 'globus', 'gs1', 'gsma', 'gvat', 'hbbtv',
  'ieee', 'ietf', 'iptc', 'isan', 'isbn', 'isni', 'iso', 'issn', 'itu', 'ivis', 'knx', 'lei', 'lex', 'liberty',
  'mace', 'mef', 'meta', 'mpeg', 'mrn', 'nan', 'nato', 'nbn', 'nena', 'newsml', 'nfc', 'nfi', 'nzl', 'oasis', 'ogc',
  'ogf', 'oid', 'oipf', 'oma', 'onem2m', 'onf', 'pin', 'pno', 'publicid', 'pwid', 'reso', 's1000d', 'said', 'schac',
  'service', 'smpte', 'stalwart', 'swift', 'thread', 'trivore', 'tva', 'uci', 'ucode', 'uic', 'uuid', 'web3d', 'wfa',
  'wmo', 'xmlorg', 'xmpp',
]);
const INFORMAL_URN_NID = /^urn-[0-9]+$/;

/**
 * @param {object} manifest
 * @param {import('./diagnostics.js').Diagnostics} diagnostics
 * @param {{ knownProfiles?: Iterable<string> }} [options]
 */
export function checkManifest(manifest, diagnostics, { knownProfiles = [] } = {}) {
  const file = 'moca.json';
  for (const err of validateAgainst('manifest', manifest)) {
    diagnostics.add('M002_MANIFEST_SCHEMA', err, { file });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return;

  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key) && !/^x-[a-z0-9]+-[A-Za-z0-9-]+$/.test(key)) {
      diagnostics.add('M004_UNKNOWN_KEY', `"${key}" is not a MOCA manifest key; it is ignored. Vendor keys use x-<vendor>-<key>.`, { file });
    }
  }

  const seen = new Set();
  for (const m of Array.isArray(manifest.members) ? manifest.members : []) {
    if (!m?.id) continue;
    if (seen.has(m.id)) diagnostics.add('M005_DUPLICATE_MEMBER', `member ${m.id} is listed more than once`, { file });
    seen.add(m.id);
  }

  const from = parseInstant(manifest.validFrom);
  const until = parseInstant(manifest.validUntil);
  if (!Number.isNaN(from) && !Number.isNaN(until) && until <= from) {
    diagnostics.add('M006_VALIDITY_WINDOW_INVALID', 'validUntil must be later than validFrom', { file });
  }

  const urn = typeof manifest.id === 'string' ? manifest.id.match(/^urn:([^:]+):/i) : null;
  if (urn && !REGISTERED_URN_NIDS.has(urn[1].toLowerCase()) && !INFORMAL_URN_NID.test(urn[1].toLowerCase())) {
    diagnostics.add('M007_UNREGISTERED_URN', `"urn:${urn[1]}:" is not a registered URN namespace (RFC 8141); prefer an https: or tag: URI`, { file });
  }

  const known = new Set(knownProfiles);
  for (const uri of Object.keys(manifest.profiles ?? {})) {
    if (!known.has(uri)) diagnostics.add('F001_PROFILE_UNRECOGNISED', `profile ${uri} is not recognised; its data is preserved but not interpreted`, { file });
  }
}

/** Package spec §4.6: the first bytes of each image type. */
const SIGNATURES = {
  'image/png': (b) => b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
};
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));

/**
 * Package spec §4.6: why an image fails its checks, or null when it passes. A Reader never decodes an image.
 * @param {{ src: string, type: string }} image
 * @param {Map<string, Uint8Array>} bytes  package files by NFC path
 * @param {number} maxImageBytes
 */
export function imageProblem(image, bytes, maxImageBytes) {
  const data = bytes.get(image.src.normalize('NFC'));
  if (!data) return `${image.src} is not a file in the package`;
  if (data.length > maxImageBytes) return `${image.src} is ${data.length} bytes, over the limit of ${maxImageBytes}`;
  if (!SIGNATURES[image.type]?.(data)) return `${image.src} does not start with the signature of ${image.type}`;
  return null;
}

/** Sets a key taken from a package as an own property, so "__proto__" stays data. */
const put = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });

/** Package spec §2: case-insensitive means A-Z and a-z only. */
const foldAscii = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Package spec §4.8: a tag list without case-insensitive repeats; each repeat is M012. */
function dedupeTags(tags, where, diagnostics) {
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const key = foldAscii(tag);
    if (seen.has(key)) {
      diagnostics.add('M012_TAG_DUPLICATE', `${where} repeats the tag "${tag}"; the repeat is dropped`, { file: 'moca.json' });
      continue;
    }
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Package spec §4.6–4.8: images, translations and tags, checked once the manifest passes its schema.
 * @returns {{ images?: object[], translations?: object, tags?: string[] }} what the result exposes
 */
export function checkCatalogue(manifest, bytes, diagnostics, { maxImageBytes }) {
  const file = 'moca.json';
  const out = {};
  const declared = new Set();
  const dropped = new Set();
  if (manifest.images !== undefined) {
    out.images = [];
    for (const image of manifest.images) {
      declared.add(image.src);
      const problem = imageProblem(image, bytes, maxImageBytes);
      if (problem) {
        diagnostics.add('M010_IMAGE_INVALID', `${problem}; the image is left out`, { file });
        dropped.add(image.src);
        continue;
      }
      out.images.push({ ...image });
    }
  }
  if (manifest.tags !== undefined) out.tags = dedupeTags(manifest.tags, 'tags', diagnostics);
  if (manifest.translations !== undefined) {
    const locales = new Set((manifest.locales ?? []).map(foldAscii));
    out.translations = {};
    for (const [tag, value] of Object.entries(manifest.translations)) {
      if (!locales.has(foldAscii(tag))) {
        diagnostics.add('M011_TRANSLATION_LOCALE_UNDECLARED', `translations has "${tag}", which is not a tag in locales`, { file });
      }
      const t = {};
      for (const [k, v] of Object.entries(value)) put(t, k, v);
      if (value.tags !== undefined) t.tags = dedupeTags(value.tags, `translations.${tag}.tags`, diagnostics);
      if (value.alt !== undefined) {
        t.alt = {};
        for (const [src, text] of Object.entries(value.alt)) {
          if (!declared.has(src)) {
            diagnostics.add('M013_ALT_IMAGE_UNKNOWN', `translations.${tag}.alt names ${src}, which is not in images; it is dropped`, { file });
            continue;
          }
          // An image dropped with M010 takes its alt text with it, without a further diagnostic.
          if (!dropped.has(src)) put(t.alt, src, text);
        }
      }
      put(out.translations, tag, t);
    }
  }
  return out;
}
