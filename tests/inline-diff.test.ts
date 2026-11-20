import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineChanges } from '../src/web/inline-diff.js';
import type { DiffLine } from '../src/web/types.js';

function changed(lines: DiffLine[], key: string): string[] {
  const line = lines.find(item => item.key === key)!;
  return (inlineChanges(lines).get(key) ?? []).map(range => line.text.slice(range.start, range.end));
}

test('marks only changed characters in paired replacement lines', () => {
  const lines: DiffLine[] = [
    { key: 'old', kind: 'deletion', text: 'return oldValue + count;' },
    { key: 'new', kind: 'addition', text: 'return newValue + count;' },
  ];
  assert.deepEqual(changed(lines, 'old'), ['old']);
  assert.deepEqual(changed(lines, 'new'), ['new']);
});

test('handles insertions, unicode and unpaired lines without inventing changes', () => {
  const lines: DiffLine[] = [
    { key: 'old', kind: 'deletion', text: '😀 value' },
    { key: 'new', kind: 'addition', text: '😀 new value' },
    { key: 'extra', kind: 'addition', text: 'extra line' },
  ];
  assert.deepEqual(changed(lines, 'old'), []);
  assert.deepEqual(changed(lines, 'new'), ['new ']);
  assert.deepEqual(changed(lines, 'extra'), []);
});

test('does not add misleading highlights to unrelated replacement lines', () => {
  const lines: DiffLine[] = [
    { key: 'old', kind: 'deletion', text: 'alpha' },
    { key: 'new', kind: 'addition', text: 'uvwxyz' },
  ];
  assert.deepEqual(changed(lines, 'old'), []);
  assert.deepEqual(changed(lines, 'new'), []);
});

test('highlights a small change in a long line', () => {
  const prefix = 'unchanged '.repeat(100);
  const suffix = ' remaining'.repeat(100);
  const lines: DiffLine[] = [
    { key: 'old', kind: 'deletion', text: `${prefix}old${suffix}` },
    { key: 'new', kind: 'addition', text: `${prefix}new${suffix}` },
  ];
  assert.deepEqual(changed(lines, 'old'), ['old']);
  assert.deepEqual(changed(lines, 'new'), ['new']);
});
