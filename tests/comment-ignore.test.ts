import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCommentIgnoreStatus } from '../src/server/comment-ignore.js';

test('reports git ignore rules, negations, and tracked review files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-ignore-'));
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checks nested ignore files and reports errors instead of treating them as unignored', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-ignore-nested-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', '.gitignore'), '*.md\n');
    assert.deepEqual(await getCommentIgnoreStatus(root, 'nested/review.md'), { path: 'nested/review.md', ignored: true, tracked: false });
    assert.deepEqual(await getCommentIgnoreStatus(root, '../outside.md'), { path: join(root, '../outside.md'), ignored: false, tracked: false });
    const outside = mkdtempSync(join(tmpdir(), 'review-not-git-'));
    try { await assert.rejects(getCommentIgnoreStatus(outside, 'review.md')); }
    finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
