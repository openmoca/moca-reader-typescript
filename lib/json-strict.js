// I-JSON (RFC 7493) checks a plain JSON.parse does not make: no object may
// repeat a member name. Used for moca.json (M001) and attestation statements
// (A001), so every Reader reads the same `id` from the same bytes.

/**
 * Contract §3: the most levels JSON or frontmatter may be nested: a value may lie inside this many arrays and objects
 * (sequences and mappings), counting the outermost. Fixed, so every Reader agrees on what is malformed.
 */
export const MAX_NESTING = 64;

/**
 * Whether a JSON text opens more than `max` arrays and objects at once. One pass over the text, before it is parsed,
 * so the parser never meets nesting it would have to recurse into.
 * @param {string} text
 * @param {number} [max]
 */
export function nestedTooDeep(text, max = MAX_NESTING) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (c === '{' || c === '[') {
      depth += 1;
      if (depth > max) return true;
    } else if (c === '}' || c === ']') {
      depth -= 1;
    }
  }
  return false;
}

/** JSON.parse for package content: a text nested more than MAX_NESTING levels deep is refused, like any malformed text. */
export function parseJson(text) {
  if (nestedTooDeep(text)) throw new SyntaxError(`nested more than ${MAX_NESTING} levels deep`);
  return JSON.parse(text);
}

/**
 * The first repeated member name in a JSON text that has already parsed, or null.
 * @param {string} text
 * @returns {string|null}
 */
export function duplicateKey(text) {
  const stack = []; // per container: a Set of keys for objects, null for arrays
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (expectKey && top) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (c === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (c === '[') {
      stack.push(null);
      expectKey = false;
    } else if (c === '}' || c === ']') {
      stack.pop();
      expectKey = false;
    } else if (c === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return null;
}
