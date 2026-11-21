// YAML frontmatter for OKF concept documents.
//
// Parsed with the YAML core schema, so timestamps stay strings exactly as
// written: a reader must never reinterpret `2026-08-14` as a local-time Date.
import * as yaml from 'js-yaml';
import { MAX_NESTING } from './json-strict.js';

// Package spec §5.1: a YAML 1.2 core number too large to be finite (1e400, or a very long integer) is read as .inf is.
// js-yaml's core schema leaves such a scalar a string, so this tag, tried after the core ones, reads it as a number.
const DECIMAL = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const OCTAL = /^0o[0-7]+$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const OVERFLOW = yaml.defineScalarTag('tag:openmoca.org,2026:number-overflow', {
  implicit: true,
  resolve: (text, isExplicit) => {
    if (isExplicit) return yaml.NOT_RESOLVED;
    if (DECIMAL.test(text)) return Number(text);
    if (OCTAL.test(text) || HEX.test(text)) return Number(BigInt(text));
    return yaml.NOT_RESOLVED;
  },
});
const SCHEMA = yaml.CORE_SCHEMA.withTags(OVERFLOW);

const OPEN = /^---[ \t]*\r?\n/;
// Package spec §5.1: only LF ends a line (CRLF is LF after CR), so no `m` flag: it would also split at CR, U+2028 and U+2029.
const CLOSE = /(?:^|(?<=\n))---[ \t]*(?:\r?\n|(?![\s\S]))/;

/**
 * @param {string} text  full file text
 * @param {{ maxBytes?: number }} [options]  refuse larger frontmatter (untrusted input)
 * @returns {{ present: boolean, raw?: string, data?: any, error?: string, body: string, bodyOffset: number, line: number }}
 *   bodyOffset is the UTF-8 byte offset where the Markdown body starts.
 */
export function splitFrontmatter(text, { maxBytes = Infinity } = {}) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const rest = text.slice(bom.length);
  const open = rest.match(OPEN);
  if (!open) return { present: false, body: text, bodyOffset: Buffer.byteLength(bom), line: 1 };
  const afterOpen = rest.slice(open[0].length);
  const close = afterOpen.match(CLOSE);
  if (!close) {
    return { present: true, error: 'frontmatter block is not closed with ---', body: text, bodyOffset: 0, line: 1 };
  }
  const raw = afterOpen.slice(0, close.index);
  const consumed = bom + open[0] + afterOpen.slice(0, close.index + close[0].length);
  const body = text.slice(consumed.length);
  const result = { present: true, raw, body, bodyOffset: Buffer.byteLength(consumed), line: 1 };
  if (Buffer.byteLength(raw) > maxBytes) {
    result.error = `frontmatter is larger than the ${maxBytes}-byte limit`;
    return result;
  }
  try {
    // Aliases are refused: OKF frontmatter never needs them, and alias expansion is a denial-of-service vector.
    // Contract §3: frontmatter nested more than MAX_NESTING levels deep is invalid; the mapping itself is level 1.
    result.data = raw.trim() === '' ? {} : yaml.load(raw, { schema: SCHEMA, maxAliases: 0, maxDepth: MAX_NESTING });
  } catch (err) {
    result.error = err.reason ?? err.message;
    if (err.mark?.line !== undefined) result.line = err.mark.line + 2;
    return result;
  }
  // YAML 1.2 §7.4: an implicit key is at most 1,024 characters. js-yaml checks this only when writing.
  // YAML 1.2 §5.7: an escape is a Unicode character; js-yaml reads one past U+10FFFF as two lone surrogates.
  let longKey = -1;
  let badEscape = -1;
  try {
    if (raw.length > 1024) longKey = longImplicitKey(raw);
    if (raw.includes('\\U')) badEscape = escapePastUnicode(raw);
  } catch (err) {
    // Contract §5: every problem is a finding. A second pass that fails is frontmatter that does not parse.
    result.error = err.reason ?? err.message;
    delete result.data;
    return result;
  }
  if (badEscape >= 0) {
    result.error = 'a double-quoted escape is past U+10FFFF, so it is not a Unicode character';
    result.line = raw.slice(0, badEscape).split('\n').length + 1;
    delete result.data;
    return result;
  }
  if (longKey >= 0) {
    result.error = 'an implicit mapping key is longer than 1,024 characters; write it as an explicit key (? )';
    result.line = raw.slice(0, longKey).split('\n').length + 1;
    delete result.data;
    return result;
  }
  if (result.data === null || typeof result.data !== 'object' || Array.isArray(result.data)) {
    result.error = 'frontmatter is not a YAML mapping';
  }
  return result;
}

/**
 * Serialises a frontmatter mapping plus body. Key order is preserved.
 * @param {object} data
 * @param {string} body
 */
export function joinFrontmatter(data, body) {
  const dumped = yaml.dump(data, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true, quotingType: '"' });
  return `---\n${dumped}---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

/**
 * Adds keys to the top of an existing frontmatter block without touching the
 * rest of it, so an author's formatting and comments survive. Used by
 * converters to supply an OKF `type` a source file lacks.
 *
 * @param {string} text  full file text
 * @param {object} additions
 */
export function prependFrontmatterKeys(text, additions) {
  const lines = yaml.dump(additions, { schema: yaml.CORE_SCHEMA, lineWidth: -1, quotingType: '"' });
  const split = splitFrontmatter(text);
  if (!split.present) return `---\n${lines}---\n\n${text.replace(/^\n+/, '')}`;
  const open = text.match(/^﻿?---[ \t]*\r?\n/)[0];
  return `${open}${lines}${text.slice(open.length)}`;
}

/** Where a node starts in the text: its anchor or tag when it has one, else its opening quote or first character. */
function nodeStart(e) {
  const own = e.type === yaml.EVENT_SCALAR
    ? e.valueStart - (e.style === yaml.SCALAR_STYLE_SINGLE_QUOTED || e.style === yaml.SCALAR_STYLE_DOUBLE_QUOTED ? 1 : 0)
    : e.start;
  return Math.min(...[own, e.anchorStart, e.tagStart].filter((x) => typeof x === 'number' && x >= 0));
}

/** True when the key at `at` follows an explicit-key indicator (`? `). */
function explicitKey(text, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (text[i] !== '?') return false;
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j -= 1;
  return j < 0 || '\n-{,['.includes(text[j]);
}

/**
 * The offset of the first escape in a double-quoted scalar that names a code point past U+10FFFF (`\U` and eight hex
 * digits), or -1. Only double-quoted scalars have escapes, so a `\U` in a plain or single-quoted scalar or a comment is
 * text, and an escaped backslash (`\\`) is skipped whole.
 */
function escapePastUnicode(text) {
  for (const e of yaml.parseEvents(text, { maxDepth: MAX_NESTING })) {
    if (e.type !== yaml.EVENT_SCALAR || e.style !== yaml.SCALAR_STYLE_DOUBLE_QUOTED) continue;
    for (let i = e.valueStart; i < e.valueEnd; i++) {
      if (text[i] !== '\\') continue;
      if (text[i + 1] === 'U' && /^[0-9A-Fa-f]{8}$/.test(text.slice(i + 2, i + 10)) && Number.parseInt(text.slice(i + 2, i + 10), 16) > 0x10ffff) return i;
      i += 1;
    }
  }
  return -1;
}

/**
 * The offset of the first implicit mapping key whose text, from its start to its `:`, is longer than 1,024
 * characters (YAML 1.2 §7.4, as PyYAML and YamlDotNet apply it), or -1.
 */
function longImplicitKey(text) {
  const stack = [];
  const done = () => {
    const parent = stack.at(-1);
    if (parent?.map) parent.expectKey = !parent.expectKey;
  };
  // The text has already loaded within the nesting limit, so the same limit applies here.
  for (const e of yaml.parseEvents(text, { maxDepth: MAX_NESTING })) {
    if (e.type === yaml.EVENT_DOCUMENT) {
      stack.push({ map: false });
      continue;
    }
    if (e.type === yaml.EVENT_POP) {
      stack.pop();
      done();
      continue;
    }
    const parent = stack.at(-1);
    const start = e.type === yaml.EVENT_ALIAS ? -1 : nodeStart(e);
    if (parent?.map && start >= 0) {
      if (parent.expectKey) {
        parent.keyStart = start;
      } else if (parent.keyStart >= 0 && !explicitKey(text, parent.keyStart)) {
        const colon = text.lastIndexOf(':', start - 1);
        if (colon > parent.keyStart && [...text.slice(parent.keyStart, colon)].length > 1024) return parent.keyStart;
      }
    }
    if (e.type === yaml.EVENT_MAPPING || e.type === yaml.EVENT_SEQUENCE) {
      stack.push({ map: e.type === yaml.EVENT_MAPPING, expectKey: true, keyStart: -1 });
    } else {
      done();
    }
  }
  return -1;
}
