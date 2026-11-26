import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from '../src/review/index.js';

test('drafts persist and published Markdown is protected', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-store-'));
  let store = new ReviewStore(root);
  try {
    const thread = store.create({ path: 'a.ts', line: 4, side: 'new', body: 'Check this' });
    assert.equal(readdirSync(root).length, 0);
    store.dispose();
    store = new ReviewStore(root);
    assert.equal(store.list()[0].messages[0].body, 'Check this');
    store.publish(thread.id);
    const file = store.markdownPath();
    assert.match(readFileSync(file, 'utf8'), /Check this/);
    store.resolve(thread.id, true);
    assert.match(readFileSync(file, 'utf8'), /Status: resolved/);
    writeFileSync(file, 'modified externally');
    assert.throws(() => store.resolve(thread.id, false), /changed externally/i);
    assert.equal(readFileSync(file, 'utf8'), 'modified externally');
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('keeps a discussion on its uniquely identifiable line as code moves', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-anchor-'));
  writeFileSync(join(root, 'code.ts'), 'first\nsecond\n');
  const store = new ReviewStore(root);
  try {
    store.create({ path: 'code.ts', line: 2, side: 'new', body: 'Check' });
    assert.equal(store.list()[0].stale, false);
    writeFileSync(join(root, 'code.ts'), 'inserted\nfirst\nsecond\n');
    assert.equal(store.list()[0].stale, false);
    assert.equal(store.list()[0].line, 3);
    writeFileSync(join(root, 'code.ts'), 'second\nfirst\nsecond\n');
    assert.equal(store.list()[0].stale, true);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('reports stale anchors when the file disappears, range is ambiguous, or content no longer matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stale-'));
  writeFileSync(join(root, 'code.ts'), 'first\nsecond\nthird\n');
  const store = new ReviewStore(root);
  try {
    const unique = store.create({ path: 'code.ts', line: 2, side: 'new', body: 'unique' });
    const range = store.create({ path: 'code.ts', startLine: 1, line: 2, side: 'new', body: 'range' });
    const missing = store.create({ path: 'missing.ts', line: 1, side: 'new', body: 'missing' });
    assert.equal(unique.stale, false);
    assert.equal(range.stale, false);
    assert.equal(missing.stale, true);
    writeFileSync(join(root, 'code.ts'), 'first\nsecond\nsecond\nthird\n');
    assert.equal(store.list().find(thread => thread.id === unique.id)?.stale, true);
    writeFileSync(join(root, 'code.ts'), 'changed\ncontent\n');
    assert.equal(store.list().find(thread => thread.id === range.id)?.stale, true);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('rejects invalid comments directories and allows repeated disposal', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-invalid-dir-'));
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'file');
  assert.throws(() => new ReviewStore(root, '   '), /must not be empty/);
  assert.throws(() => new ReviewStore(root, 'not-a-directory'), /not a directory/);
  const store = new ReviewStore(root);
  store.dispose();
  store.dispose();
  assert.throws(() => store.list(), /closed/);
  rmSync(root, { recursive: true, force: true });
});
