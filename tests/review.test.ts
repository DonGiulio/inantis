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
