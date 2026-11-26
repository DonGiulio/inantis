import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocale, resolveLocale, systemLocale, translate, AppError, AppAggregateError, errorMessage } from '../src/locales/index.js';
import { renderReview } from '../src/export/index.js';

test('negotiates registered languages, quality values and fallback errors', () => {
  registerLocale('fr', { invalidSearch: 'Recherche invalide', reviewTitle: 'RÃ©vision {id}', threadNotFound: 'Message introuvable: {id}' });
  assert.equal(resolveLocale('de, fr-CA;q=0.8, en;q=0.5'), 'fr');
  assert.equal(resolveLocale('fr;q=0, de'), 'en');
  assert.equal(resolveLocale(), 'en');
  assert.equal(resolveLocale('fr_FR;q=0.7, en;q=0.7'), 'fr');
  assert.equal(resolveLocale('fr;q=1.1, de;q=NaN, en;q=-1'), 'en');
  assert.equal(resolveLocale('*'), 'en');
  assert.equal(resolveLocale('fr-CA-x-private'), 'fr');
  assert.equal(translate('fr', 'invalidSearch'), 'Recherche invalide');
  assert.equal(translate('fr', 'invalidPath'), 'Invalid path');
  assert.equal(new AppError('threadNotFound', { id: 'abc' }).message, 'Thread not found: abc');
  assert.equal(new AppError('threadNotFound', { id: 'abc' }).localized('fr'), 'Message introuvable: abc');
  assert.equal(new AppAggregateError([new Error('underlying')], 'reviewCloseFailed').localized('fr'), 'Review close failed and Markdown could not be restored');
  assert.equal(errorMessage(new AppError('threadNotFound', { id: 'abc' }), 'fr'), 'Message introuvable: abc');
  assert.equal(errorMessage(new AppAggregateError([], 'reviewUpdateFailed'), 'fr'), 'Review update failed and Markdown could not be restored');
  assert.equal(errorMessage(new Error('plain'), 'fr'), 'plain');
  assert.equal(errorMessage({ code: 'EIO' }, 'fr'), '[object Object]');
  assert.equal(renderReview('abc', [], 'fr'), '# RÃ©vision abc\n');

  const env = { LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG };
  try {
    process.env.LC_ALL = 'fr_FR.UTF-8';
    assert.equal(systemLocale(), 'fr');
    delete process.env.LC_ALL;
    process.env.LC_MESSAGES = 'fr_CA';
    assert.equal(systemLocale(), 'fr');
    delete process.env.LC_MESSAGES;
    process.env.LANG = 'fr_FR@euro';
    assert.equal(systemLocale(), 'fr');
    delete process.env.LANG;
    assert.equal(systemLocale(), 'en');
  } finally {
    if (env.LC_ALL === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = env.LC_ALL;
    if (env.LC_MESSAGES === undefined) delete process.env.LC_MESSAGES; else process.env.LC_MESSAGES = env.LC_MESSAGES;
    if (env.LANG === undefined) delete process.env.LANG; else process.env.LANG = env.LANG;
  }
});
