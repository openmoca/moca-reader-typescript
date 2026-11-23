// A file swapped for a symbolic link between listing and reading must not be followed
// (CodeQL js/file-system-race, alert 7). The swap is made at the worst moment: right after the
// path's last check, before the file is opened. The Reader must not return the link target's bytes.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { directorySource } from '../lib/source.js';

const ORIGINAL = 'the file that was listed\n';
const SECRET = 'a file outside the package\n';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'moca-race-'));
  const dir = join(root, 'pkg');
  mkdirSync(join(dir, 'content'), { recursive: true });
  writeFileSync(join(dir, 'content', 'a.md'), ORIGINAL);
  writeFileSync(join(root, 'secret.txt'), SECRET);
  return { root, dir, target: join(root, 'secret.txt') };
}

function canSymlink(root) {
  try {
    symlinkSync(join(root, 'secret.txt'), join(root, 'probe-link'));
    rmSync(join(root, 'probe-link'));
    return true;
  } catch {
    return false;
  }
}

test('a file swapped for a symlink after the last check is not followed', (t) => {
  const { root, dir, target } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (!canSymlink(root)) return t.skip('this account cannot create symbolic links');

  const source = directorySource(dir);
  assert.deepEqual(source.list().map((e) => [e.path, e.kind]), [['content/a.md', 'file']]);

  const abs = resolve(dir, 'content', 'a.md');
  const realLstat = fs.lstatSync;
  const realOpen = fs.openSync;
  let swapped = false;
  const swap = (p) => {
    if (swapped || resolve(String(p)) !== abs) return;
    swapped = true;
    rmSync(abs);
    symlinkSync(target, abs);
  };
  // The swap is made at the first touch of the file by whatever the Reader does: after a check
  // has seen a regular file, or just before the file is opened.
  mock.method(fs, 'lstatSync', (p, ...rest) => {
    const result = realLstat(p, ...rest);
    swap(p);
    return result;
  });
  mock.method(fs, 'openSync', (p, ...rest) => {
    swap(p);
    return realOpen(p, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  let bytes;
  try {
    bytes = source.read('content/a.md');
  } catch {
    return; // refusing the read is correct
  }
  assert.ok(swapped, 'the test did not reach the window it is about');
  // Reading the listed file's own bytes is also safe; the link target's bytes are not.
  assert.notEqual(bytes.toString(), SECRET, 'read the bytes of the symlink target');
});

test('a regular file is still read', () => {
  const { root, dir } = setup();
  try {
    assert.equal(directorySource(dir).read('content/a.md').toString(), ORIGINAL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink that was there at listing time is refused at reading', (t) => {
  const { root, dir, target } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (!canSymlink(root)) return t.skip('this account cannot create symbolic links');
  const source = directorySource(dir);
  source.list();
  rmSync(join(dir, 'content', 'a.md'));
  symlinkSync(target, join(dir, 'content', 'a.md'));
  assert.throws(() => source.read('content/a.md'));
});
