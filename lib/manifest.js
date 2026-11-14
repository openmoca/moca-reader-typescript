// Manifest checks beyond the JSON Schema. See spec/moca-package-spec.md §4.
import { parseInstant } from './dates.js';
import { validateAgainst } from './schemas.js';

export const MANIFEST_KEYS = new Set([
  '$schema', 'mocaVersion', 'id', 'version', 'title', 'description', 'language', 'locales', 'license',
  'publisher', 'distribution', 'validFrom', 'validUntil', 'members', 'relations', 'profiles',
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
