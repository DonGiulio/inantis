import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocale, selectLocale, t } from '../src/web/i18n.js';

test('selects a registered language and falls back to English for missing messages', () => {
  registerLocale('fr', { compare: 'Comparer', commentOnLine: 'Ligne {line}' });
  assert.equal(selectLocale(['fr-CA', 'en']), 'fr');
  assert.equal(t('compare'), 'Comparer');
  assert.equal(t('commentOnLine', { line: 12 }), 'Ligne 12');
  assert.equal(t('closeReview'), 'Close review');
  assert.equal(selectLocale(['unknown']), 'en');
  assert.equal(t('filesCount', { count: 1 }), '1 file');
  assert.equal(t('filesCount', { count: 2 }), '2 files');
});
