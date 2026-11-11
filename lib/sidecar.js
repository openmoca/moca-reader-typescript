// Sidecar indexes: spec/moca-sidecar-index-spec.md.
import { posix } from 'node:path';
import { Diagnostics } from './diagnostics.js';
import { openSource, TargetError } from './source.js';
import { validateAgainst } from './schemas.js';

export const SIDECAR_MANIFEST = 'index.json';
export const PORTABLE_FORMAT = 'moca-jsonl-v1';

/**
 * Checks a sidecar against a package read by readPackage() and returns the
 * chunks a Library can search. A sidecar that fails any check is ignored:
 * the package stays fully usable without it.
 *
 * @param {string|object} target  sidecar directory or .zip
 * @param {object} pkg  readPackage() result
 * @param {{ strict?: boolean }} [options]
 * @returns {{ usable: boolean, index: object|null, chunks: object[], diagnostics: object[] }}
 */
export function bindSidecar(target, pkg, options = {}) {
  const diagnostics = new Diagnostics(options);
  const out = { usable: false, index: null, chunks: [], diagnostics: diagnostics.items };
  let source;
  try {
    source = openSource(target);
  } catch (err) {
    if (err instanceof TargetError) {
      diagnostics.add('S001_SIDECAR_INVALID', err.message);
      return out;
    }
    throw err;
  }
  const listed = new Map(source.list().filter((e) => e.kind === 'file').map((e) => [e.path, e]));
  if (!listed.has(SIDECAR_MANIFEST)) {
    diagnostics.add('S001_SIDECAR_INVALID', 'the sidecar has no index.json');
    return out;
  }
  let index;
  try {
    index = JSON.parse(source.read(SIDECAR_MANIFEST).toString('utf8'));
  } catch (err) {
    diagnostics.add('S001_SIDECAR_INVALID', `index.json is not valid JSON: ${err.message}`, { file: SIDECAR_MANIFEST });
    return out;
  }
  out.index = index;
  const errors = validateAgainst('sidecarIndex', index);
  for (const e of errors) diagnostics.add('S001_SIDECAR_INVALID', e, { file: SIDECAR_MANIFEST });
  if (errors.length > 0) return out;

  const m = pkg.manifest;
  if (index.target.id !== m.id || index.target.version !== m.version) {
    diagnostics.add('S002_SIDECAR_TARGET_MISMATCH', `sidecar is bound to ${index.target.id}@${index.target.version}, not ${m.id}@${m.version}`, { file: SIDECAR_MANIFEST });
    return out;
  }
  if (index.target.digest !== pkg.digest) {
    diagnostics.add('S003_SIDECAR_STALE', `sidecar was built for ${index.target.digest}; the package is ${pkg.digest}`, { file: SIDECAR_MANIFEST });
    return out;
  }
  if (index.storage.format !== PORTABLE_FORMAT) {
    diagnostics.add('S005_SIDECAR_FORMAT_UNKNOWN', `payload format "${index.storage.format}" is not ${PORTABLE_FORMAT}; the sidecar is ignored`, { file: SIDECAR_MANIFEST });
    return out;
  }
  const payloadPath = posix.normalize(index.storage.file);
  if (payloadPath.startsWith('..') || posix.isAbsolute(payloadPath) || !listed.has(payloadPath)) {
    diagnostics.add('S001_SIDECAR_INVALID', `storage.file "${index.storage.file}" is missing or outside the sidecar`, { file: SIDECAR_MANIFEST });
    return out;
  }

  const reps = new Map();
  for (const node of pkg.nodes) {
    for (const rep of node.representations) {
      reps.set(`${node.path}\u0000${rep.locale ?? ''}`, { node, rep });
    }
  }
  const lines = source.read(payloadPath).toString('utf8').split('\n').filter((l) => l.trim() !== '');
  const counts = new Map();
  let bad = 0;
  lines.forEach((line, i) => {
    const where = { file: payloadPath, line: i + 1 };
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      diagnostics.add('S004_SIDECAR_ITEM_INVALID', 'payload line is not JSON', where);
      bad++;
      return;
    }
    const problem = checkItem(item, reps, index);
    if (problem) {
      diagnostics.add('S004_SIDECAR_ITEM_INVALID', problem, where);
      bad++;
      return;
    }
    const key = `${item.path}\u0000${item.locale ?? ''}`;
    counts.set(key, (counts.get(key) ?? new Set()).add(item.chunkIndex));
    out.chunks.push(item);
  });
  for (const item of out.chunks) {
    const seen = counts.get(`${item.path}\u0000${item.locale ?? ''}`);
    if (seen.size !== item.chunkCount) {
      diagnostics.add('S004_SIDECAR_ITEM_INVALID', `${item.path}: chunkCount is ${item.chunkCount} but ${seen.size} chunk(s) are present`, { file: payloadPath });
      bad++;
      break;
    }
  }
  if (bad === 0 && index.storage.vectors) bad += attachVectors(source, listed, index, out.chunks, lines.length, diagnostics);
  out.usable = bad === 0;
  if (!out.usable) out.chunks = [];
  return out;
}

/**
 * A chunk's text: the bytes `start`..`end` of the node file, clipped to the
 * body. A sidecar's `text`, when present, has already been checked to be
 * exactly these bytes (S004); search never reads it (Reader contract §9.1).
 */
export function chunkText(chunk, rep) {
  // Contract §9.1: always the package's own bytes, never the sidecar's text.
  return sliceBody(rep, chunk.start, chunk.end);
}

/** The node file's bytes start..end, clipped to the body, as UTF-8 text. */
function sliceBody(rep, start, end) {
  const body = Buffer.from(rep.body, 'utf8');
  const from = Math.max(start - rep.bodyOffset, 0);
  const to = Math.min(end - rep.bodyOffset, body.length);
  return to > from ? body.subarray(from, to).toString('utf8') : '';
}

/** Reads storage.vectors (little-endian float32, one row per item) onto the chunks. Returns 1 on a problem. */
function attachVectors(source, listed, index, chunks, count, diagnostics) {
  const { file, dimensions } = index.storage.vectors;
  const path = posix.normalize(file);
  if (path.startsWith('..') || posix.isAbsolute(path) || !listed.has(path)) {
    diagnostics.add('S001_SIDECAR_INVALID', `storage.vectors.file "${file}" is missing or outside the sidecar`, { file: SIDECAR_MANIFEST });
    return 1;
  }
  if (index.model?.dimensions && index.model.dimensions !== dimensions) {
    diagnostics.add('S004_SIDECAR_ITEM_INVALID', `storage.vectors has ${dimensions} dimensions, model declares ${index.model.dimensions}`, { file: SIDECAR_MANIFEST });
    return 1;
  }
  const bytes = source.read(path);
  if (bytes.length !== count * dimensions * 4) {
    diagnostics.add('S004_SIDECAR_ITEM_INVALID', `${path} has ${bytes.length} bytes; ${count} items x ${dimensions} float32 needs ${count * dimensions * 4}`, { file: path });
    return 1;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  chunks.forEach((chunk, i) => {
    chunk.vector = Array.from({ length: dimensions }, (_, d) => view.getFloat32((i * dimensions + d) * 4, true));
  });
  return 0;
}

function checkItem(item, reps, index) {
  if (!item || typeof item !== 'object') return 'item is not an object';
  if (typeof item.path !== 'string' || item.path.startsWith('/') || item.path.split('/').includes('..')) return 'path must be relative to content/ without ".." segments';
  const hit = reps.get(`${item.path}\u0000${item.locale ?? ''}`);
  if (!hit) return `path "${item.path}"${item.locale ? ` (${item.locale})` : ''} is not a content node of the package`;
  if (!Number.isInteger(item.chunkCount) || item.chunkCount < 1) return 'chunkCount must be a positive integer';
  if (!Number.isInteger(item.chunkIndex) || item.chunkIndex < 0 || item.chunkIndex >= item.chunkCount) return '0 <= chunkIndex < chunkCount must hold';
  if (!Number.isInteger(item.start) || !Number.isInteger(item.end) || item.start < 0 || item.end < item.start) return 'start and end must be byte offsets with 0 <= start <= end';
  const fileEnd = hit.rep.bodyOffset + Buffer.byteLength(hit.rep.body);
  if (item.end > fileEnd) return `end ${item.end} is beyond the end of the file (${fileEnd})`;
  // Sidecar §5: a chunk lies inside the node's body, and any text it carries is
  // exactly the package's bytes there: a sidecar cannot attach other text to a node.
  if (item.start < hit.rep.bodyOffset) return `start ${item.start} is inside the frontmatter (the body starts at ${hit.rep.bodyOffset})`;
  if (item.text !== undefined && item.text !== sliceBody(hit.rep, item.start, item.end)) return 'text is not the package\'s text at start..end';
  if (item.vector !== undefined) {
    if (!Array.isArray(item.vector) || item.vector.some((v) => typeof v !== 'number')) return 'vector must be an array of numbers';
    if (index.model?.dimensions && item.vector.length !== index.model.dimensions) return `vector has ${item.vector.length} dimensions, model declares ${index.model.dimensions}`;
  }
  return null;
}
