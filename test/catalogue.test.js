import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackage } from '../lib/index.js';

// Package spec §4.6–4.8: images, translations and tags. The corpus covers the codes; these cover what it cannot.
const NODE = '---\ntype: Note\ntitle: A\n---\n\n# A\n\nText.\n';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8L')]);

function makePackage(manifest, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-catalogue-'));
  writeFileSync(join(dir, 'moca.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ id: 'https://example.com/t', version: '1.0.0', title: 'T', ...manifest }));
  for (const [path, data] of Object.entries({ 'content/a.md': NODE, ...files })) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  return dir;
}
const codes = (r) => r.diagnostics.map((d) => d.code);

test('each image type is checked by its own signature, and only by it', async () => {
  const images = [
    { src: 'media/a.png', role: 'icon', type: 'image/png' },
    { src: 'media/a.jpg', role: 'cover', type: 'image/jpeg' },
    { src: 'media/a.webp', role: 'cover', type: 'image/webp' },
    { src: 'media/b.webp', role: 'cover', type: 'image/webp' },
  ];
  const r = await readPackage(makePackage({ images }, { 'media/a.png': PNG, 'media/a.jpg': JPEG, 'media/a.webp': WEBP, 'media/b.webp': PNG }));
  assert.deepEqual(codes(r), ['M010_IMAGE_INVALID']);
  assert.deepEqual(r.images.map((i) => i.src), ['media/a.png', 'media/a.jpg', 'media/a.webp']);
});

test('an image exactly at maxImageBytes passes; one byte over does not', async () => {
  const dir = makePackage({ images: [{ src: 'media/a.png', role: 'icon', type: 'image/png' }] }, { 'media/a.png': PNG });
  assert.deepEqual(codes(await readPackage(dir, { limits: { maxImageBytes: PNG.length } })), []);
  assert.deepEqual(codes(await readPackage(dir, { limits: { maxImageBytes: PNG.length - 1 } })), ['M010_IMAGE_INVALID']);
});

test('an image under a hidden directory is not part of the package, so it is missing', async () => {
  const r = await readPackage(makePackage({ images: [{ src: 'media/.hidden/a.png', role: 'icon', type: 'image/png' }] }, { 'media/.hidden/a.png': PNG }));
  assert.deepEqual(codes(r), ['M010_IMAGE_INVALID']);
});

test('a "__proto__" key from a package stays data', async () => {
  const manifest = '{"id":"https://example.com/t","version":"1.0.0","title":"T","locales":["fr"],"images":[{"src":"media/a.png","role":"icon","type":"image/png"}],'
    + '"translations":{"fr":{"alt":{"__proto__":"x","media/a.png":"y"}}}}';
  const r = await readPackage(makePackage(manifest, { 'media/a.png': PNG }));
  assert.deepEqual(codes(r), ['M013_ALT_IMAGE_UNKNOWN']);
  assert.deepEqual(Object.keys(r.translations.fr.alt), ['media/a.png']);
  assert.equal(Object.getPrototypeOf(r.translations.fr.alt), Object.prototype);
});

test('the fields are absent when the manifest has none, and when the package is invalid', async () => {
  const none = await readPackage(makePackage({}));
  assert.equal(none.images, undefined);
  assert.equal(none.translations, undefined);
  assert.equal(none.tags, undefined);
  const invalid = await readPackage(makePackage({ tags: ['a'] }, { 'content/b.md': 'no frontmatter\n' }));
  assert.equal(invalid.valid, false);
  assert.equal(invalid.tags, undefined);
});

test('the result never shares objects with the manifest', async () => {
  const r = await readPackage(makePackage({ images: [{ src: 'media/a.png', role: 'icon', type: 'image/png' }], tags: ['a'] }, { 'media/a.png': PNG }));
  r.images[0].src = 'changed';
  r.tags.push('b');
  assert.equal(r.manifest.images[0].src, 'media/a.png');
  assert.deepEqual(r.manifest.tags, ['a']);
});
