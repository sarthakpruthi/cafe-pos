import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderStatus as s } from '../src/services/orders.js';

test('order status aggregation', () => {
  assert.equal(s(['PENDING', 'PENDING']), 'PENDING');
  assert.equal(s(['PENDING', 'ACCEPTED']), 'PARTIALLY_ACCEPTED');
  assert.equal(s(['PENDING', 'SERVED']), 'PARTIALLY_ACCEPTED');
  assert.equal(s(['ACCEPTED', 'ACCEPTED']), 'ACCEPTED');
  assert.equal(s(['ACCEPTED', 'SERVED']), 'PARTIALLY_SERVED');
  assert.equal(s(['SERVED', 'SERVED']), 'SERVED');
  assert.equal(s(['SERVED', 'REJECTED']), 'SERVED');
  assert.equal(s(['REJECTED', 'REJECTED']), 'REJECTED');
  assert.equal(s(['REJECTED', 'CANCELLED']), 'CANCELLED');
  assert.equal(s(['PENDING', 'REJECTED']), 'PARTIALLY_REJECTED');
  assert.equal(s(['ACCEPTED', 'REJECTED']), 'ACCEPTED');
});
