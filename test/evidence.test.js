import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackage, Library, selectorMatches, validateAgainst } from '../lib/index.js';

function makePackage(files) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-evidence-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/e', version: '1.0.0', title: 'E' }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const node = (sources, evidence) => `---
type: Policy
title: Refunds
sources:
${sources.map((s) => `  - {id: ${s.id}, resource: "${s.resource}"}`).join('\n')}
moca:
  evidence:
${evidence.map((e) => `    - {source: ${e.source}, selector: ${JSON.stringify(e.selector)}}`).join('\n')}
---

# Refunds
`;
const TERMS = 'Refunds: within 30 days of delivery. Café terms apply.\n';
const codes = (r) => r.diagnostics.map((d) => d.code);

test('quote and position selectors are checked exactly against the text', () => {
  assert.equal(selectorMatches({ type: 'TextQuoteSelector', exact: 'within 30 days' }, TERMS), true);
  assert.equal(selectorMatches({ type: 'TextQuoteSelector', exact: 'within 30  days' }, TERMS), false);
  assert.equal(selectorMatches({ type: 'TextQuoteSelector', exact: 'Within 30 days' }, TERMS), false);
  assert.equal(selectorMatches({ type: 'TextQuoteSelector', exact: 'days', prefix: '30 ', suffix: ' of' }, TERMS), true);
  assert.equal(selectorMatches({ type: 'TextQuoteSelector', exact: 'days', prefix: '31 ' }, TERMS), false);
  // Contract §7 (0.6): a position selector on its own is never checked.
  assert.equal(selectorMatches({ type: 'TextPositionSelector', start: 0, end: 7 }, TERMS), undefined);
  assert.equal(selectorMatches({ type: 'FragmentSelector', value: 'page=2' }, TERMS), undefined);
});

test('evidence that matches its source is marked matched, and the package is self-contained', async () => {
  const dir = makePackage({
    'sources/terms.txt': TERMS,
    'content/refunds.md': node([{ id: 'terms', resource: '../sources/terms.txt' }], [
      { source: 'terms', selector: { type: 'TextQuoteSelector', exact: 'within 30 days of delivery' } },
      { source: 'terms', selector: { type: 'TextPositionSelector', start: 0, end: 7 } },
    ]),
  });
  const pkg = await readPackage(dir);
  assert.deepEqual(codes(pkg), []);
  assert.deepEqual(pkg.capabilities, ['core', 'located-evidence', 'self-contained-evidence']);
  const [record] = new Library().add(pkg).citations();
  assert.deepEqual(record.evidence.map((e) => e.matched), [true, undefined]);
  assert.deepEqual(validateAgainst('citationRecord', record), []);
});

test('a quote that is not in the source is C011 and matched false, but still self-contained', async () => {
  const dir = makePackage({
    'sources/terms.txt': TERMS,
    'content/refunds.md': node([{ id: 'terms', resource: '../sources/terms.txt' }], [
      { source: 'terms', selector: { type: 'TextQuoteSelector', exact: 'within 60 days of delivery' } },
    ]),
  });
  const pkg = await readPackage(dir);
  assert.deepEqual(codes(pkg), ['C011_EVIDENCE_SELECTOR_UNMATCHED']);
  assert.equal(pkg.valid, true);
  assert.ok(pkg.capabilities.includes('self-contained-evidence'));
  assert.equal(new Library().add(pkg).citations()[0].evidence[0].matched, false);
  const strict = await readPackage(dir, { strict: true });
  assert.equal(strict.diagnostics[0].severity, 'error');
});

test('an external or non-text source is not checked; an external one is not self-contained', async () => {
  const dir = makePackage({
    'media/deck.pdf': '%PDF-1.7\n',
    'content/refunds.md': node([
      { id: 'deck', resource: '../media/deck.pdf' },
      { id: 'site', resource: 'https://example.com/terms' },
    ], [
      { source: 'deck', selector: { type: 'FragmentSelector', value: 'page=2', conformsTo: 'http://tools.ietf.org/rfc/rfc3778' } },
      { source: 'site', selector: { type: 'TextQuoteSelector', exact: 'anything' } },
    ]),
  });
  const pkg = await readPackage(dir);
  assert.deepEqual(codes(pkg), []);
  assert.deepEqual(pkg.capabilities, ['core', 'located-evidence']);
  assert.deepEqual(new Library().add(pkg).citations()[0].evidence.map((e) => e.matched), [undefined, undefined]);
});

test('a source outside sources/ and media/ does not count as self-contained', async () => {
  const dir = makePackage({
    'notes/terms.txt': TERMS,
    'content/refunds.md': node([{ id: 'terms', resource: '../notes/terms.txt' }], [
      { source: 'terms', selector: { type: 'TextQuoteSelector', exact: 'within 30 days' } },
    ]),
  });
  const pkg = await readPackage(dir);
  assert.deepEqual(pkg.capabilities, ['core', 'located-evidence']);
});

test('sources are normalised per type before matching', async () => {
  const { markdownText, htmlText, webvtt, mediaTimeRange } = await import('../lib/evidence-text.js');
  assert.equal(markdownText('## A *b* _c_ `d` [e](http://x) ![f](g.png)\n- item\n1. one'), 'A b c d e f\nitem\none');
  assert.equal(htmlText('<p>a &amp; b&#163;<script>x</script></p>'), 'a & b£');
  const v = webvtt('WEBVTT\n\nNOTE x\n\n00:01.000 --> 00:02.500\n<i>Hi</i> there\n\n01:00:00.000 --> 01:00:01.000\nLate');
  assert.deepEqual(v.cues.map((c) => [c.start, c.end]), [[1, 2.5], [3600, 3601]]);
  assert.equal(v.text, 'Hi there\nLate');
  assert.deepEqual(mediaTimeRange('t=10,20'), { start: 10, end: 20 });
  assert.deepEqual(mediaTimeRange('t=npt:00:01:05'), { start: 65, end: Infinity });
  assert.equal(mediaTimeRange('t=20,10'), null);
});
