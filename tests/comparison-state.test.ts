import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreComparison } from '../src/web/comparison-state.js';

test('restores the selected comparison for the same launch base', () => {
  assert.deepEqual(restoreComparison({ mode: 'ref', reference: 'release/1', launchBase: 'main' }, 'main'), { mode: 'ref', reference: 'release/1' });
  assert.deepEqual(restoreComparison({ mode: 'working', reference: '', launchBase: null }, null), { mode: 'working', reference: '' });
});

test('a different explicit launch base overrides the previous comparison', () => {
  assert.deepEqual(restoreComparison({ mode: 'ref', reference: 'release/1', launchBase: 'main' }, 'develop'), { mode: 'branch', reference: 'develop' });
  assert.deepEqual(restoreComparison({ mode: 'invalid', reference: 'release/1' }, null), { mode: 'branch', reference: '' });
});
