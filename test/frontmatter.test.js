import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontmatter } from '../lib/frontmatter.js';

// Package spec §5.1 and YAML 1.2 §7.4: an implicit key, from its start to its colon, is at most 1,024 characters.
const k = (n) => 'k'.repeat(n);
const read = (yaml) => splitFrontmatter(`---\ntype: Note\n${yaml}\n---\n`);

test('an implicit key of 1,024 characters is read; one of 1,025 is refused', () => {
  assert.equal(read(`${k(1024)}: v`).error, undefined);
  const refused = read(`${k(1025)}: v`);
  assert.match(refused.error, /longer than 1,024 characters/);
  assert.equal(refused.line, 3);
  assert.equal(refused.data, undefined);
});

test('the quotes of a key count toward its length', () => {
  assert.equal(read(`"${k(1022)}": v`).error, undefined);
  assert.match(read(`'${k(1023)}': v`).error, /1,024/);
});

test('the limit applies in nested and flow mappings, and to a key with no value', () => {
  assert.match(read(`m:\n  ${k(1025)}: v`).error, /1,024/);
  assert.match(read(`l:\n  - ${k(1025)}: v`).error, /1,024/);
  assert.match(read(`m: {${k(1025)}: v}`).error, /1,024/);
  assert.match(read(`${k(1025)}:\nb: 1`).error, /1,024/);
});

test('an explicit key and a long value have no such limit', () => {
  assert.equal(read(`? ${k(3000)}\n: v`).error, undefined);
  assert.equal(read(`m: {? ${k(3000)} : v}`).error, undefined);
  assert.equal(read(`v: ${k(5000)}\nw: x`).error, undefined);
});

test('numbers too large to be finite are read as .inf is (package spec §5.1)', () => {
  const { data } = read(`a: 1e400\nb: -1e400\nc: 0x${'f'.repeat(300)}\nd: ${'9'.repeat(5000)}\ne: "1e400"\nf: 0x10`);
  assert.deepEqual(data, { type: 'Note', a: Infinity, b: -Infinity, c: Infinity, d: Infinity, e: '1e400', f: 16 });
});

test('a double-quoted escape past U+10FFFF is not a Unicode character: the frontmatter is invalid (C002)', () => {
  const fm = (yaml) => splitFrontmatter(`---\n${yaml}\n---\nbody`);
  const past = fm('a: 1\ntitle: "\\U00110000"');
  assert.match(past.error, /U\+10FFFF/);
  assert.equal(past.line, 3);
  assert.equal(past.data, undefined);
  assert.equal(fm('title: "\\U0010FFFF"').data.title, '\u{10FFFF}');
  // Only double-quoted scalars have escapes; an escaped backslash is text.
  for (const text of ['title: "\\\\U00110000"', 'title: \\U00110000', "title: '\\U00110000'", '# "\\U00110000"\ntitle: a']) {
    assert.equal(fm(text).error, undefined, text);
  }
});
