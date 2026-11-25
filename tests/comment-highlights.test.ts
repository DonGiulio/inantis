import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentLineClasses } from '../src/web/comment-highlights.js';
import type { Thread } from '../src/web/types.js';

const thread = (side: 'old' | 'new', line: number | null, startLine?: number): Thread => ({
  id: 'test', path: 'file.ts', side, line, startLine, resolved: false, messages: [],
});

test('marks each line of a multiline comment, including its boundaries', () => {
  const comments = [thread('new', 5, 3)];
  assert.deepEqual(commentLineClasses(comments, undefined, 2), {});
  assert.deepEqual(commentLineClasses(comments, undefined, 3), { 'commented-line': true, 'commented-new': true, 'comment-range-start': true });
  assert.deepEqual(commentLineClasses(comments, undefined, 4), { 'commented-line': true, 'commented-new': true });
  assert.deepEqual(commentLineClasses(comments, undefined, 5), { 'commented-line': true, 'commented-new': true, 'comment-range-end': true });
  assert.deepEqual(commentLineClasses(comments, undefined, 6), {});
});

test('respects the side and combines overlapping and single-line comments', () => {
  const comments = [thread('old', 4, 2), thread('new', 8), thread('new', null)];
  assert.deepEqual(commentLineClasses(comments, undefined, 3), {});
  assert.deepEqual(commentLineClasses(comments, 2, 8), { 'commented-line': true, 'commented-old': true, 'commented-new': true, 'comment-range-start': true, 'comment-range-end': true });
  assert.deepEqual(commentLineClasses(comments, 4, undefined), { 'commented-line': true, 'commented-old': true, 'comment-range-end': true });
});
