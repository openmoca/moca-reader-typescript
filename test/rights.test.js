// Rights and dates (moca-spec package spec §4.12, §4.14; Reader contract §7, §15.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTerms, resolveExport, rightsOf, recordTerms } from '../lib/terms.js';

test('export resolves from the package; the platform default is true; a malformed value counts as false', () => {
  assert.deepEqual(resolveExport({ terms: {} }), { value: true, decidedBy: 'platform' });
  assert.deepEqual(resolveExport({ terms: { rights: { export: { allowed: false } } } }), { value: false, decidedBy: 'package' });
  assert.deepEqual(resolveExport({ terms: { rights: { export: { allowed: true } } } }), { value: true, decidedBy: 'package' });
  assert.deepEqual(resolveExport({ terms: { rights: { export: { allowed: 'no' } } } }), { value: false, decidedBy: 'package' });
});

test('a copyright year range whose first year is after its last is U001, in the package and in a node entry', () => {
  const problems = checkTerms({ rights: { copyright: { year: '2026-2024' } }, nodes: [{ paths: ['content/a.md'], rights: { copyright: { year: '2025-2020' } } }] });
  const paths = problems.map((p) => `${p.code} ${p.path}`).sort();
  assert.deepEqual(paths, ['U001_TERMS_INVALID nodes.0.rights.copyright.year', 'U001_TERMS_INVALID rights.copyright.year']);
  assert.deepEqual(checkTerms({ rights: { copyright: { year: '2024-2026' } } }), []);
});

test("a node's licence and copyright come from its entry, else the package's; a value with a problem is skipped", () => {
  const terms = {
    rights: { copyright: { notice: '© 2026 Example' } },
    nodes: [{ paths: ['content/photo.md'], rights: { license: 'CC-BY-4.0', copyright: { holder: { name: 'A. Photographer' } } } }],
  };
  assert.deepEqual(rightsOf(terms, [], 'CC-BY-SA-4.0', 'ep1.md'), { license: 'CC-BY-SA-4.0', copyright: { notice: '© 2026 Example' } });
  assert.deepEqual(rightsOf(terms, [], 'CC-BY-SA-4.0', 'photo.md'), { license: 'CC-BY-4.0', copyright: { holder: { name: 'A. Photographer' } } });
  const problems = [{ code: 'U001_TERMS_INVALID', path: 'nodes.0.rights.copyright.holder' }, { code: 'U001_TERMS_INVALID', path: 'rights.copyright' }];
  assert.deepEqual(rightsOf(terms, problems, undefined, 'photo.md'), { license: 'CC-BY-4.0' });
});

test('a record from a gated search carries terms.rights.export', () => {
  const t = recordTerms('unverified', { 'allowed.device': { value: true, decidedBy: 'platform' } }, null, { value: false, decidedBy: 'package' });
  assert.deepEqual(t.rights, { export: { value: false, decidedBy: 'package' } });
});
