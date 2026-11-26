import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCommentIgnoreStatus } from '../src/server/comment-ignore.js';

test('reports ignore status, portable paths, and Git errors', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'review-ignore-'));
  const root = join(parent, 'repo');
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init');
    git('config', 'core.excludesFile', '/dev/null');
    writeFileSync(join(root, '.gitignore'), '.agentic-review-*.md\n!.agentic-review-exception.md\n');
    const ignored = '.agentic-review-new.md';
    assert.deepEqual(await getCommentIgnoreStatus(root, join(root, ignored)), { path: ignored, ignored: true, tracked: false });
    assert.deepEqual(await getCommentIgnoreStatus(root, '.agentic-review-exception.md'), { path: '.agentic-review-exception.md', ignored: false, tracked: false });
    writeFileSync(join(root, ignored), 'review');
    git('add', '-f', ignored);
    assert.deepEqual(await getCommentIgnoreStatus(root, ignored), { path: ignored, ignored: true, tracked: true });

    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', '.gitignore'), '*.md\n');
    assert.deepEqual(await getCommentIgnoreStatus(root, 'nested/review.md'), { path: 'nested/review.md', ignored: true, tracked: false });
    assert.deepEqual(await getCommentIgnoreStatus(root, '../outside.md'), { path: join(root, '../outside.md'), ignored: false, tracked: false });

    assert.deepEqual(await getCommentIgnoreStatus(root, 'nested'), { path: 'nested', ignored: false, tracked: false });
    assert.deepEqual(await getCommentIgnoreStatus(root, root), { path: root, ignored: false, tracked: false });
    assert.deepEqual(await getCommentIgnoreStatus(root, '..'), { path: join(root, '..'), ignored: false, tracked: false });
    assert.deepEqual(await getCommentIgnoreStatus(root, 'nested/../.agentic-review-new.md'), { path: '.agentic-review-new.md', ignored: true, tracked: true });
    assert.deepEqual(await getCommentIgnoreStatus(root, ''), { path: root, ignored: false, tracked: false });
    const outside = join(tmpdir(), 'review-output.md');
    assert.deepEqual(await getCommentIgnoreStatus(root, outside), { path: outside, ignored: false, tracked: false });
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'file');
    await assert.rejects(getCommentIgnoreStatus(file, 'review.md'));
  } finally { rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
