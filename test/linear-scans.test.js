// Contract §3: a Reader's work is bounded by the size of what it reads. The scanners here replace regular
// expressions; each must give what the expression gave on the inputs it handled, and its steps must grow in line with
// its input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredPrefixes } from '../lib/structure.js';
import { withoutTrailingSlashes } from '../lib/source.js';
import { logHeading } from '../lib/content.js';

// The expressions the scanners replace, kept here as the reference on short inputs.
const PREFIX_DECL = /^\s*(?:@prefix|PREFIX)\s+([A-Za-z][\w.-]*)?:/gim;
const expectedPrefixes = (text) => [...text.matchAll(PREFIX_DECL)].map((m) => m[1]).filter(Boolean);
const expectedTrim = (name) => name.replace(/\/+$/, '');
const expectedHeading = (line) => line.match(/^##\s+(.*)$/)?.[1] ?? null;

const MIB = 1024 * 1024;

test('declared prefixes: the scanner gives what the expression gives, form by form', () => {
  const table = [
    ['@prefix e: <https://e.org/> .', ['e']],
    ['PREFIX e: <https://e.org/>', ['e']],
    ['prefix e: <https://e.org/>', ['e']],
    ['@PreFix e: <https://e.org/> .', ['e']],
    ['@PREFIX e: <https://e.org/> .', ['e']],
    ['PREFIX e: <https://e.org/>\n  @Prefix f.g-h_1: <https://f.org/> .', ['e', 'f.g-h_1']],
    ['@prefix : <https://e.org/> .', []],
    ['@prefix\n\n  e: <https://e.org/> .', ['e']],
    ['@prefix\n\nPREFIX e: <https://e.org/>', ['e']],
    ['@prefix\r\ne: <https://e.org/> .', ['e']],
    ['@prefix e: <https://e.org/> .', ['e']],
    ['x @prefix e: <https://e.org/> .', []],
    ['　prefix e:', ['e']],
    ['﻿@prefix e: <https://e.org/> .', ['e']],
    ['\t  @prefix e: <https://e.org/> .', ['e']],
    ['@prefixe: <https://e.org/> .', []],
    ['@prefix 1e: <https://e.org/> .', []],
    ['@prefix e1:a <https://e.org/> .', ['e1']],
    ['@prefix e <https://e.org/> .', []],
    ['@prefix é: <https://e.org/> .', []],
    ['@prefix eé: <https://e.org/> .', []],
    ['# @prefix e: <https://e.org/> .', []],
    ['#\n@prefix e: <https://e.org/> . # @prefix f: <https://f.org/> .', ['e']],
    ['@prefix e: <https://e.org/> . @prefix f: <https://f.org/> .', ['e']],
    ['@prefix e: <https://e.org/x:y> .\n@prefix f: <urn:f:> .', ['e', 'f']],
    ['<https://e.org/>\n@prefix e: <https://e.org/> .', ['e']],
    ['"""\n@prefix e: <https://e.org/> .\n"""', ['e']],
    ['PREFIX\nPREFIX: <https://e.org/>', ['PREFIX']],
    ['@prefix\n@prefix e: <https://e.org/> .', ['e']],
    ['@prefix @prefix e: <https://e.org/> .', []],
    ['\n\n\r\r\n  \t@prefix e: <https://e.org/> .\n\n', ['e']],
    ['@pre\nfix e:', []],
    ['@prefi', []],
    ['@prefix', []],
    ['', []],
  ];
  for (const [text, names] of table) {
    assert.deepEqual(expectedPrefixes(text), names, `the expression on ${JSON.stringify(text)}`);
    assert.deepEqual(declaredPrefixes(text), names, `the scanner on ${JSON.stringify(text)}`);
  }
});

test('declared prefixes: the scanner gives what the expression gives on generated texts', () => {
  const words = ['@prefix', 'PREFIX', 'prefix', '@PreFix', 'pReFiX', 'e', 'ab.c-d', 'x_1', ':', '\n', '\r\n', '\r',
    ' ', ' ', '\t', '　', '﻿', '#', '<urn:x:y>', '.', '@', 'ſ', 'K', 'ı', '"'];
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let k = 0; k < 20000; k++) {
    let text = '';
    const parts = 1 + (next() % 12);
    for (let j = 0; j < parts; j++) text += words[next() % words.length];
    assert.deepEqual(declaredPrefixes(text), expectedPrefixes(text), JSON.stringify(text));
  }
});

test('declared prefixes: steps grow in line with the text, at 4 MiB', () => {
  const cases = {
    'blank lines': (n) => '\n'.repeat(n),
    spaces: (n) => ' '.repeat(n),
    'a keyword then blank lines': (n) => `@prefix${'\n'.repeat(n - 7)}`,
    'a repeated keyword': (n) => '@prefix\n'.repeat(n / 8),
    'a repeated keyword with no line ends': (n) => '@prefix '.repeat(n / 8),
    'keywords on blank lines': (n) => '@prefix\n\n'.repeat(n / 9),
  };
  for (const [name, make] of Object.entries(cases)) {
    for (const size of [MIB / 4, 4 * MIB]) {
      const text = make(size);
      const work = { steps: 0 };
      declaredPrefixes(text, work);
      assert.ok(work.steps <= 3 * text.length + 3, `${name} at ${size} characters: ${work.steps} steps`);
    }
  }
});

test('trailing slashes: the scanner gives what the expression gives', () => {
  for (const name of ['', '/', '//', 'a', 'a/', 'a//', 'a/b', 'a/b/', '/a', 'a//b//', 'content/x.md', 'content/']) {
    assert.equal(withoutTrailingSlashes(name), expectedTrim(name), JSON.stringify(name));
  }
});

test('trailing slashes: steps grow in line with the name', () => {
  for (const name of [`a${'/'.repeat(65535)}b`, '/'.repeat(4 * MIB), `a${'/'.repeat(4 * MIB)}`]) {
    const work = { steps: 0 };
    withoutTrailingSlashes(name, work);
    assert.ok(work.steps <= name.length, `${work.steps} steps for ${name.length} characters`);
  }
});

test('log.md headings: the scanner gives what the expression gives on ordinary headings', () => {
  const lines = ['## 2026-11-22', '## 2026-11-22 Release', '##\t2026-11-22', '##  \t 2026-11-22  ', '## 2026-11-22\t',
    '## Release', '## ', '##\t', '##', '#', '', '### 2026-11-22', '###', '##2026-11-22', ' ## 2026-11-22',
    '## 26-11-22', '## 2026-1-22', '## \u00a02026-11-22', '##\u30002026-11-22', '## \ufeff2026-11-22', 'x ## 2026-11-22',
    '## 2026-11-22 ## 2026-11-23', '## é', '# 2026-11-22'];
  for (const line of lines) assert.equal(logHeading(line), expectedHeading(line), JSON.stringify(line));
});

test('log.md headings: CR, U+2028 and U+2029 are part of the heading text', () => {
  const table = [
    ['## Release\rnotes', 'Release\rnotes'],
    ['## 2026-11-22\rnotes', '2026-11-22\rnotes'],
    ['## Release\u2028notes', 'Release\u2028notes'],
    ['## Release\u2029', 'Release\u2029'],
    ['##\r2026-11-22', '2026-11-22'],
    ['## \r', ''],
  ];
  for (const [line, text] of table) assert.equal(logHeading(line), text, JSON.stringify(line));
});

test('log.md headings: steps grow in line with the line, at 4 MiB', () => {
  const lines = [`##${' '.repeat(4 * MIB)}x\r`, `## ${'x '.repeat(2 * MIB)}\u2028`, `##${'\t'.repeat(4 * MIB)}`];
  for (const line of lines) {
    const work = { steps: 0 };
    const text = logHeading(line, work);
    assert.ok(text !== null && work.steps <= line.length, `${work.steps} steps for ${line.length} characters`);
  }
});
