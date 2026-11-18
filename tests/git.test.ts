import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDiff } from '../src/git/index.js';

test('compares the working tree with HEAD including staged, unstaged and untracked files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'file name.txt'), 'old\n'); writeFileSync(join(root, '.gitignore'), 'ignored\n');
    git('add', '.'); git('commit', '-m', 'initial');
    writeFileSync(join(root, 'file name.txt'), 'staged\n'); git('add', 'file name.txt');
    writeFileSync(join(root, 'file name.txt'), 'working\n');
    writeFileSync(join(root, 'new file.txt'), 'new\n'); writeFileSync(join(root, 'ignored'), 'ignored\n');
    const result = await getDiff(root, 'working');
    assert.deepEqual(result.files.map(f => f.path).sort(), ['file name.txt', 'new file.txt']);
    assert.match(result.files.find(f => f.path === 'file name.txt')!.patch, /\+working/);
    assert.match(result.files.find(f => f.path === 'new file.txt')!.patch, /\+new/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('requires an explicit base for committed repositories without an upstream or branch origin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-initial-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'committed.txt'), 'committed\n');
    git('add', '.'); git('commit', '-m', 'initial');
    writeFileSync(join(root, 'local.txt'), 'local\n');
    await assert.rejects(() => getDiff(root, 'upstream'), /upstream/i);
    await assert.rejects(() => getDiff(root, 'branch'), /branch/i);
    assert.deepEqual((await getDiff(root, 'working')).files.map(file => file.path), ['local.txt']);
    git('checkout', '--detach');
    await assert.rejects(() => getDiff(root, 'upstream'), /upstream/i);
    await assert.rejects(() => getDiff(root, 'branch'), /branch/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('does not use an empty tree for an unpushed branch with a known origin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-origin-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git('add', '.'); git('commit', '-m', 'initial'); git('checkout', '-b', 'feature');
    writeFileSync(join(root, 'feature.txt'), 'feature\n');
    const result = await getDiff(root, 'branch');
    assert.deepEqual(result.files.map(file => file.path), ['feature.txt']);
    await assert.rejects(() => getDiff(root, 'upstream'), /upstream/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('identifies uncommitted files in a branch comparison without marking committed-only files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-branch-status-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git('add', '.'); git('commit', '-m', 'base'); git('tag', 'base-release');
    const baseBranch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
    git('checkout', '-b', 'feature');
    writeFileSync(join(root, 'committed.txt'), 'committed\n');
    writeFileSync(join(root, 'mixed.txt'), 'committed\n');
    git('add', '.'); git('commit', '-m', 'feature');
    writeFileSync(join(root, 'mixed.txt'), 'modified\n');
    writeFileSync(join(root, 'staged.txt'), 'staged\n'); git('add', 'staged.txt');
    writeFileSync(join(root, 'untracked.txt'), 'untracked\n');
    const result = await getDiff(root, 'branch');
    assert.deepEqual(result.baseRefs, [baseBranch]);
    assert.deepEqual(result.baseTags, ['base-release']);
    assert.deepEqual(result.headTags, []);
    assert.deepEqual(Object.fromEntries(result.files.map(file => [file.path, file.uncommitted])), {
      'committed.txt': false, 'mixed.txt': true, 'staged.txt': true, 'untracked.txt': true,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
