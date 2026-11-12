// The pinned Lemon Squeezy ids must be integers (unset ids would unlock any key, #5442) and match the live
// product in the catalogue. Run with `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LS_IDS, LS_BUY_URL } from '../static/licence.js';

test('LS_IDS are the live store and product, as integers', () => {
  assert.deepEqual({ ...LS_IDS }, { storeId: 416615, productId: 1500320 });
  assert.ok(Number.isInteger(LS_IDS.storeId) && Number.isInteger(LS_IDS.productId));
  assert.ok(Object.isFrozen(LS_IDS));
});

test('LS_BUY_URL is an https checkout on the Marc Riera store', () => {
  assert.match(LS_BUY_URL, /^https:\/\/marcriera\.lemonsqueezy\.com\/checkout\/buy\/[0-9a-f-]{36}$/);
});
