// A deterministic bag-of-words embedder for tests. Not a real model.
const DIMENSIONS = 16;

export function toyEmbedder({ name = 'toy-bow', version = '1', dimensions = DIMENSIONS } = {}) {
  return {
    name,
    version,
    dimensions,
    embed: async (texts) => texts.map((text) => {
      const v = new Array(dimensions).fill(0);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.codePointAt(0)) >>> 0;
        v[h % dimensions] += 1;
      }
      return v;
    }),
  };
}

export default toyEmbedder();
