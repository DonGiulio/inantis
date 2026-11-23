import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDiff, getDiffContext, streamDiff } from '../src/git/index.js';

test('streams metadata then each file in raw order with its current patch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stream-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'old a\n');
    writeFileSync(join(root, 'b.txt'), 'old b\n');
    git('add', '.'); git('commit', '-m', 'base');
    writeFileSync(join(root, 'a.txt'), 'new a\n');
    writeFileSync(join(root, 'b.txt'), 'new b\n');
    // Files are prefetched, so the stream does not guarantee per-file freshness against
    // edits made mid-stream; a stale context is rejected later by its contextId (409).
    const events = [];
    for await (const event of streamDiff(root, 'working')) events.push(event);
    assert.equal(events[0].type, 'metadata');
    const files = events.slice(1).map(event => {
      assert.equal(event.type, 'file');
      if (event.type !== 'file') throw new Error('expected file');
      return event.file;
    });
    assert.deepEqual(files.map(file => file.path), ['a.txt', 'b.txt']);
    assert.match(files[1].patch, /\+new b/);
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

test('stream skips untracked nested repositories instead of failing on their numstat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stream-nested-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'base'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, 'plain.txt'), 'hello\n');
    const nested = join(root, 'nested');
    mkdirSync(nested);
    execFileSync('git', ['init'], { cwd: nested, stdio: 'ignore' });
    writeFileSync(join(nested, 'inner.txt'), 'inner\n');

    const paths: string[] = [];
    for await (const event of streamDiff(root, 'working')) {
      if (event.type === 'file') paths.push(event.file.path);
    }
    assert.deepEqual(paths, ['plain.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stream keeps raw order and per-file counts when many files are processed concurrently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stream-many-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    const tracked = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, '0')}.txt`);
    for (const name of tracked) writeFileSync(join(root, name), 'base\n');
    git('add', '.'); git('commit', '-m', 'base');
    tracked.forEach((name, i) => writeFileSync(join(root, name), Array.from({ length: i + 1 }, (_, n) => `line ${n}\n`).join('') + 'base\n'));
    const untracked = Array.from({ length: 10 }, (_, i) => `u${String(i).padStart(2, '0')}.txt`);
    untracked.forEach((name, i) => writeFileSync(join(root, name), Array.from({ length: i + 1 }, () => 'new\n').join('')));

    const files = [];
    for await (const event of streamDiff(root, 'working')) if (event.type === 'file') files.push(event.file);
    assert.deepEqual(files.map(file => file.path), [...tracked, ...untracked]);
    assert.deepEqual(files.map(file => file.additions), [...tracked.map((_, i) => i + 1), ...untracked.map((_, i) => i + 1)]);
    assert.deepEqual(files.map(file => file.deletions), [...tracked.map(() => 0), ...untracked.map(() => 0)]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stream patches and counts match direct git output for renames, binary, mode-only and untracked files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stream-oracle-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'text.txt'), 'a\nb\n');
    writeFileSync(join(root, 'old.txt'), 'same content\n');
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, 'mode.sh'), 'run\n');
    git('add', '.'); git('commit', '-m', 'base');
    writeFileSync(join(root, 'text.txt'), 'a\nc\nd\n');
    git('mv', 'old.txt', 'new.txt');
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 3]));
    git('update-index', '--chmod=+x', 'mode.sh');
    writeFileSync(join(root, 'untracked.txt'), 'x\ny\n');

    const files = [];
    for await (const event of streamDiff(root, 'working')) if (event.type === 'file') files.push(event.file);
    const byPath = new Map(files.map(file => [file.path, file]));
    const direct = (...args: string[]) => git('diff', '--no-ext-diff', '--no-textconv', '--find-renames', ...args);

    assert.equal(byPath.get('text.txt')!.patch, direct('HEAD', '--', ':(literal)text.txt'));
    assert.equal(byPath.get('text.txt')!.additions, 2);
    assert.equal(byPath.get('text.txt')!.deletions, 1);
    assert.equal(byPath.get('new.txt')!.patch, direct('HEAD', '--', ':(literal)old.txt', ':(literal)new.txt'));
    assert.equal(byPath.get('new.txt')!.oldPath, 'old.txt');
    assert.equal(byPath.get('bin.dat')!.binary, true);
    assert.equal(byPath.get('bin.dat')!.patch, direct('HEAD', '--', ':(literal)bin.dat'));
    assert.equal(byPath.get('mode.sh')!.patch, direct('HEAD', '--', ':(literal)mode.sh'));
    assert.equal(byPath.get('mode.sh')!.additions, 0);
    assert.equal(byPath.get('untracked.txt')!.additions, 2);
    assert.match(byPath.get('untracked.txt')!.patch, /\+x\n\+y\n/);
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
  const root = mkdtempSync(join(tmpdir(), 'review-stream-symlink-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    mkdirSync(join(root, 'target'));
    writeFileSync(join(root, 'target', 'nested.txt'), 'nested\n');
    try {
      symlinkSync('target', join(root, 'plugin-link'), 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const permissionDenied = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
      if (permissionDenied && process.env.INANTIS_REQUIRE_SYMLINK_TEST !== '1') {
        t.skip('Creating symlinks is not permitted for this local Windows user');
        return;
      }
      throw error;
    }
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
