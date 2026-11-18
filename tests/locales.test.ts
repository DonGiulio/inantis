import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocale, resolveLocale, translate, AppError } from '../src/locales/index.js';
import { renderReview } from '../src/export/index.js';

test('negotiates registered languages and falls back to English', () => {
  registerLocale('fr', { invalidSearch: 'Recherche invalide', reviewTitle: 'Révision {id}' });
  assert.equal(resolveLocale('de, fr-CA;q=0.8, en;q=0.5'), 'fr');
  assert.equal(resolveLocale('fr;q=0, de'), 'en');
  assert.equal(translate('fr', 'invalidSearch'), 'Recherche invalide');
  assert.equal(translate('fr', 'invalidPath'), 'Invalid path');
  assert.equal(new AppError('threadNotFound', { id: 'abc' }).message, 'Thread not found: abc');
  assert.equal(renderReview('abc', [], 'fr'), '# Révision abc\n');
});
