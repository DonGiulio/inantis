import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapOrdered } from '../src/git/map-ordered.js';

test('starts up to eight operations and yields results in input order', async () => {
  const items = Array.from({ length: 10 }, (_, index) => index);
  const work = items.map(() => Promise.withResolvers<number>());
  const started: number[] = [];
  const results = mapOrdered(items, 8, (item) => {
    started.push(item);
    return work[item].promise;
  });

  const first = results.next();
  assert.deepEqual(started, items.slice(0, 8));

  work[1].resolve(1);
  work[0].resolve(0);
  assert.deepEqual(await first, { value: 0, done: false });
  assert.deepEqual(started, items.slice(0, 8));

  assert.deepEqual(await results.next(), { value: 1, done: false });
  assert.deepEqual(started, items.slice(0, 9));

  for (const item of items.slice(2).reverse()) work[item].resolve(item);
  const remaining: number[] = [];
  for await (const result of results) remaining.push(result);
  assert.deepEqual(started, items);
  assert.deepEqual(remaining, items.slice(2));
});
