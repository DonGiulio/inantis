import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReviewStore } from '../src/review/index.js';

test('normalizes, persists and exports multiline ranges while retaining drafts', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-range-'));
  writeFileSync(join(root, 'code.ts'), 'one\ntwo\nthree\nfour\n');
  let store = new ReviewStore(root);
  try {
    const draft = store.create({ path: 'code.ts', line: 2, side: 'new', body: 'draft' });
    const range = store.create({ path: 'code.ts', startLine: 4, line: 2, side: 'new', body: 'range' });
    assert.equal(range.startLine, 2);
    assert.equal(range.line, 4);
    assert.equal(range.stale, false);
    store.dispose();
    store = new ReviewStore(root);
    assert.equal(store.list()[0].messages[0].body, 'draft');
    assert.equal(store.list()[1].startLine, 2);
    store.publish(range.id);
    const markdown = readFileSync(store.markdownPath(), 'utf8');
    assert.match(markdown, /"code\.ts":2-4/);
    assert.doesNotMatch(markdown, /draft/);
    store.publish(draft.id);
    assert.match(readFileSync(store.markdownPath(), 'utf8'), /"code\.ts":2\n/);
    writeFileSync(join(root, 'code.ts'), 'one\nchanged\nthree\nfour\n');
    assert.equal(store.list()[1].stale, true);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('rejects invalid range coordinates and sides without creating a thread', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-invalid-range-'));
  const store = new ReviewStore(root);
  try {
    for (const input of [
      { line: 0, side: 'new' }, { line: 1.5, side: 'new' },
      { line: 1, startLine: 0, side: 'new' }, { line: null, startLine: 1, side: 'new' },
      { line: 1, side: 'invalid' },
    ]) {
      assert.throws(() => store.create({ path: 'code.ts', body: 'x', ...input } as Parameters<typeof store.create>[0]));
    }
    assert.equal(store.list().length, 0);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('legacy single-line anchors remain valid and old-side ranges remain stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-legacy-range-'));
  writeFileSync(join(root, 'code.ts'), 'one\ntwo\nthree\n');
  let store = new ReviewStore(root);
  try {
    store.create({ path: 'code.ts', line: 2, side: 'new', body: 'legacy' });
    store.dispose();
    const key = createHash('sha256').update(realpathSync(root)).digest('hex');
    const db = new DatabaseSync(join(homedir(), '.agentic-change-reviewer', `${key}.sqlite`));
    try {
      const row = db.prepare('SELECT threads FROM review WHERE singleton = 1').get() as { threads: string };
      const threads = JSON.parse(row.threads);
      delete threads[0].startLine;
      db.prepare('UPDATE review SET threads = ? WHERE singleton = 1').run(JSON.stringify(threads));
    } finally { db.close(); }
    store = new ReviewStore(root);
    assert.equal(store.list()[0].stale, false);
    assert.equal(store.list()[0].messages[0].body, 'legacy');
    const old = store.create({ path: 'code.ts', line: 3, startLine: 1, side: 'old', body: 'old range' });
    assert.equal(old.stale, true);
    assert.equal(old.startLine, 1);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});
