import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('diff-perf verifier handles staged additions, binary files and dangling symlinks', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'verify-stream-'));
  const root = join(parent, 'repo');
  await mkdir(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    await writeFile(join(root, 'tracked.txt'), 'one\n');
    await writeFile(join(root, 'old-name.txt'), 'renamed content\n');
    git('add', '.'); git('commit', '-m', 'initial');
    git('mv', 'old-name.txt', 'new-name.txt');
    await writeFile(join(root, 'staged.txt'), 'staged\nlines\n');
    git('add', 'staged.txt');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 0, 255]));
    await writeFile(join(root, 'untracked.txt'), 'a\nb\nc\n');
    try { await symlink('missing-target', join(root, 'dangling')); } catch { /* symlinks need privileges on some Windows setups */ }

    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/diff-perf/verify-stream-against-git.mts', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /problems 0/);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
