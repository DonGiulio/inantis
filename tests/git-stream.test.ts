import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDiff, getDiffContext, streamDiff } from '../src/git/index.js';

test('streams metadata and each file before computing the next file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stream-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'old a\n');
    writeFileSync(join(root, 'b.txt'), 'old b\n');
    git('add', '.'); git('commit', '-m', 'base');
    writeFileSync(join(root, 'a.txt'), 'new a\n');
    writeFileSync(join(root, 'b.txt'), 'new b\n');
    const stream = streamDiff(root, 'working');
    const metadata = await stream.next();
    assert.equal(metadata.value?.type, 'metadata');
    const first = await stream.next();
    assert.equal(first.value?.type, 'file');
    if (first.value?.type !== 'file') throw new Error('expected file');
    assert.equal(first.value.file.path, 'a.txt');
    writeFileSync(join(root, 'b.txt'), 'later b\n');
    const second = await stream.next();
    assert.equal(second.value?.type, 'file');
    if (second.value?.type !== 'file') throw new Error('expected file');
    assert.equal(second.value.file.path, 'b.txt');
    assert.match(second.value.file.patch, /\+later b/);
    assert.equal((await stream.next()).done, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stream matches the ordinary diff for renames, binary and untracked files, with usable context IDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stream-equivalence-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'old name.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]));
    git('add', '.'); git('commit', '-m', 'base');
    renameSync(join(root, 'old name.txt'), join(root, 'new name.txt'));
    git('add', '-A');
    writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 3]));
    writeFileSync(join(root, '-untracked'), 'new\n');
    const expected = await getDiff(root, 'working');
    const events = [];
    for await (const event of streamDiff(root, 'working')) events.push(event);
    assert.deepEqual(events[0], { type: 'metadata', root: expected.root, branch: expected.branch, base: expected.base, baseIsEmpty: expected.baseIsEmpty, baseLabel: expected.baseLabel, baseRefs: expected.baseRefs, baseTags: expected.baseTags, headTags: expected.headTags });
    const files = events.slice(1).map(event => {
      assert.equal(event.type, 'file');
      if (event.type !== 'file') throw new Error('expected file');
      return event.file;
    });
    assert.deepEqual(files, expected.files);
    const renamed = files.find(file => file.path === 'new name.txt')!;
    assert.equal(renamed.oldPath, 'old name.txt');
    assert.equal(files.find(file => file.path === 'binary')!.binary, true);
    assert.match(await getDiffContext(root, 'working', undefined, '-untracked', files.find(file => file.path === '-untracked')!.contextId), /\+new/);
    writeFileSync(join(root, '-untracked'), 'changed\n');
    await assert.rejects(() => getDiffContext(root, 'working', undefined, '-untracked', files.find(file => file.path === '-untracked')!.contextId), { statusCode: 409 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stream propagates invalid reference errors before metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stream-error-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await assert.rejects(() => streamDiff(root, 'ref', 'missing-ref').next());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shows untracked symlinks to directories without following their contents', async (t) => {
  if (process.platform === 'win32') { t.skip('Creating symlinks requires Windows privileges'); return; }
  const root = mkdtempSync(join(tmpdir(), 'review-stream-symlink-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    mkdirSync(join(root, 'target'));
    writeFileSync(join(root, 'target', 'nested.txt'), 'nested\n');
    symlinkSync('target', join(root, 'plugin-link'));
    const result = await getDiff(root, 'working');
    const link = result.files.find(file => file.path === 'plugin-link');
    assert.ok(link);
    assert.equal(link.additions, 1);
    assert.equal(link.deletions, 0);
    assert.match(link.patch, /new file mode 120000/);
    assert.match(link.patch, /^\+target$/m);
    assert.equal(await getDiffContext(root, 'working', undefined, 'plugin-link', link.contextId), link.patch);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
