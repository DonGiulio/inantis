import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server/server.js';
import { parseExpandedPatch } from '../src/web/types.js';

test('omitted context retains both line numbers above, between, and below hunks', () => {
  const patch = `@@ -3,3 +3,4 @@
 three
-old
+new
+extra
 five
@@ -9,3 +10,3 @@
 nine
-ten
+TEN
 eleven
`;
  const fullPatch = `@@ -1,13 +1,14 @@
 one
 two
 three
-old
+new
+extra
 five
 six
 seven
 eight
 nine
-ten
+TEN
 eleven
 twelve
 thirteen
`;
  const lines = parseExpandedPatch(patch, fullPatch);
  const gaps = lines.filter(line => line.kind === 'gap');
  assert.deepEqual(gaps.map(gap => gap.hiddenLines?.map(line => [line.text, line.oldLine, line.newLine])), [
    [['one', 1, 1], ['two', 2, 2]],
    [['six', 6, 7], ['seven', 7, 8], ['eight', 8, 9]],
    [['twelve', 12, 13], ['thirteen', 13, 14]],
  ]);
  assert.deepEqual(lines.filter(line => line.kind === 'hunk').map(line => line.text), ['@@ -3,3 +3,4 @@', '@@ -9,3 +10,3 @@']);
  assert.equal(lines[0].kind, 'gap');
  assert.equal(lines[lines.length - 1].kind, 'gap');
  assert.equal(lines[lines.findIndex(line => line.text === '@@ -9,3 +10,3 @@') - 1].kind, 'gap');
});

test('context endpoint uses the selected base and the paths from the actual diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-context-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  await writeFile(join(root, 'old name.txt'), original.join('\n') + '\n');
  await writeFile(join(root, 'deleted.txt'), 'a wholly different file\n');
  await writeFile(join(root, 'pure old.txt'), 'unchanged first\nunchanged second\n');
  git('add', '.'); git('commit', '-m', 'base');
  await rename(join(root, 'old name.txt'), join(root, 'new name.txt'));
  await rename(join(root, 'pure old.txt'), join(root, 'pure new.txt'));
  const modified = [...original]; modified[9] = 'changed';
  await writeFile(join(root, 'new name.txt'), modified.join('\n') + '\n');
  await rm(join(root, 'deleted.txt'));
  git('add', '-A');
  const app = await createServer(root);
  try {
    const diff = (await app.inject('/api/diff?mode=working')).json();
    const renamed = diff.files.find((file: { path: string }) => file.path === 'new name.txt');
    assert.equal(renamed.oldPath, 'old name.txt');
    const response = await app.inject(`/api/diff/context?mode=working&path=${encodeURIComponent('new name.txt')}&id=${renamed.contextId}`);
    assert.equal(response.statusCode, 200);
    const expanded = parseExpandedPatch(renamed.patch, response.json().patch);
    assert.deepEqual(expanded.filter(line => line.kind === 'gap').map(line => line.hiddenLines?.map(hidden => hidden.text)), [
      ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'],
      ['line 14', 'line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'line 20'],
    ]);
    const removedFile = diff.files.find((file: { path: string }) => file.path === 'deleted.txt');
    const deleted = await app.inject(`/api/diff/context?mode=working&path=deleted.txt&id=${removedFile.contextId}`);
    assert.equal(deleted.statusCode, 200);
    assert.match(deleted.json().patch, /-a wholly different file/);
    const pure = diff.files.find((file: { path: string }) => file.path === 'pure new.txt');
    assert.equal(pure.oldPath, 'pure old.txt');
    const pureResponse = await app.inject(`/api/diff/context?mode=working&path=${encodeURIComponent('pure new.txt')}&id=${pure.contextId}`);
    assert.equal(pureResponse.statusCode, 200);
    const pureGap = parseExpandedPatch(pure.patch, pureResponse.json().patch).find(line => line.kind === 'gap');
    assert.deepEqual(pureGap?.hiddenLines?.map(line => [line.text, line.oldLine, line.newLine]), [
      ['unchanged first', 1, 1], ['unchanged second', 2, 2],
    ]);
    const missing = await app.inject('/api/diff/context?mode=working&path=..%2Foutside&id=invalid');
    assert.equal(missing.statusCode, 400);
    modified[1] = 'changed after loading';
    await writeFile(join(root, 'new name.txt'), modified.join('\n') + '\n');
    const stale = await app.inject(`/api/diff/context?mode=working&path=${encodeURIComponent('new name.txt')}&id=${renamed.contextId}`);
    assert.equal(stale.statusCode, 409);
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('context follows an explicit historical ref and supports untracked additions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-context-ref-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  const lines = Array.from({ length: 16 }, (_, i) => `base ${i + 1}`);
  await writeFile(join(root, 'file.txt'), lines.join('\n'));
  git('add', '.'); git('commit', '-m', 'base');
  lines[7] = 'committed change';
  await writeFile(join(root, 'file.txt'), lines.join('\n'));
  git('add', '.'); git('commit', '-m', 'next');
  await writeFile(join(root, 'new.txt'), 'new without newline');
  const app = await createServer(root);
  try {
    const diff = (await app.inject('/api/diff?mode=ref&ref=HEAD~1')).json();
    const file = diff.files.find((item: { path: string }) => item.path === 'file.txt');
    const response = await app.inject(`/api/diff/context?mode=ref&ref=HEAD~1&path=file.txt&id=${file.contextId}`);
    assert.equal(response.statusCode, 200);
    const expanded = parseExpandedPatch(file.patch, response.json().patch);
    const gaps = expanded.filter(line => line.kind === 'gap');
    assert.equal(gaps[0].hiddenLines?.[0].text, 'base 1');
    assert.equal(gaps.at(-1)?.hiddenLines?.at(-1)?.text, 'base 16');
    const added = diff.files.find((item: { path: string }) => item.path === 'new.txt');
    const addition = await app.inject(`/api/diff/context?mode=ref&ref=HEAD~1&path=new.txt&id=${added.contextId}`);
    assert.equal(addition.statusCode, 200);
    assert.match(addition.json().patch, /\+new without newline/);
    assert.equal(parseExpandedPatch(added.patch, addition.json().patch).some(line => line.kind === 'gap'), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
