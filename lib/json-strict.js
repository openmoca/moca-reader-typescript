// I-JSON (RFC 7493) checks a plain JSON.parse does not make: no object may
// repeat a member name. Used for moca.json (M001) and attestation statements
// (A001), so every Reader reads the same `id` from the same bytes.

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
