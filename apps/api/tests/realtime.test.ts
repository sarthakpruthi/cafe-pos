import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEvent, matches, type Audience, type Listener } from '../src/realtime.js';

const manager: Listener = { kind: 'staff', managerOnly: true };
const staff: Listener = { kind: 'staff', managerOnly: false };
const tableA: Listener = { kind: 'public', sessionId: 'A' };
const tableB: Listener = { kind: 'public', sessionId: 'B' };

function reached(aud: Audience): string[] {
  const listeners: Array<[string, Listener]> = [
    ['manager', manager],
    ['staff', staff],
    ['tableA', tableA],
    ['tableB', tableB],
  ];
  return listeners.filter(([, listener]) => matches(aud, listener)).map(([name]) => name);
}

test('audience routing', () => {
  // Staff-wide events reach both staff logins, never a customer.
  assert.deepEqual(reached({ staff: true }), ['manager', 'staff']);
  // Manager-only events skip the staff login — this is what keeps bills private.
  assert.deepEqual(reached({ staff: true, managerOnly: true }), ['manager']);
  // A session event reaches only that table's stream.
  assert.deepEqual(reached({ sessionId: 'A' }), ['tableA']);
  assert.deepEqual(reached({ sessionId: 'B' }), ['tableB']);
  // A menu change is broadcast to every open customer stream.
  assert.deepEqual(reached({ publicMenu: true }), ['tableA', 'tableB']);
  assert.deepEqual(reached({ publicMenu: true, staff: true }), ['manager', 'staff', 'tableA', 'tableB']);
  // Nothing requested, nobody told.
  assert.deepEqual(reached({}), []);
});

test('SSE frame format', () => {
  const frame = formatEvent({
    eventId: 'e1', type: 'order.created', occurredAt: '2026-01-01T00:00:00.000Z', payload: { orderId: 'o1' },
  });
  assert.match(frame, /^id: e1\nevent: order\.created\ndata: \{.*\}\n\n$/);
  assert.equal(JSON.parse(frame.split('\ndata: ')[1].trim()).payload.orderId, 'o1');
});
