import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, client } from './helpers.js';
import { db } from '../src/db.js';

let base = ''; let server: any;
let mgr: ReturnType<typeof client>, staff: ReturnType<typeof client>, anon: ReturnType<typeof client>;
let tokens: string[] = []; let chai = '', coffee = '', cake = '';
before(async () => {
  ({ base, server } = await boot());
  mgr = client(base); staff = client(base); anon = client(base);
  assert.equal(await mgr.login('manager'), 200);
  assert.equal(await staff.login('staff'), 200);
  tokens = (await db.query(`SELECT qr_token FROM cafe_tables ORDER BY length(table_number), table_number`)).rows.map((r: any) => r.qr_token);
  const ids = (await db.query(`SELECT id, name FROM menu_items`)).rows;
  chai = ids.find((i: any) => i.name === 'Chai').id; coffee = ids.find((i: any) => i.name === 'Coffee').id; cake = ids.find((i: any) => i.name === 'Sold out cake').id;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const scan = async (token: string) => {
  const c = client(base);
  const r = await c.post(`/public/tables/${token}/session`);
  c.setSessionToken(r.body.sessionToken);
  return { c, sessionId: r.body.sessionId as string, status: r.status };
};
const order = (c: ReturnType<typeof client>, sid: string, items: any[], key?: string) =>
  c.post(`/public/sessions/${sid}/orders`, { idempotencyKey: key ?? `key-${Math.random().toString(36).slice(2)}-xx`, items });
const tableId = async (n: number) => (await db.query(`SELECT id FROM cafe_tables WHERE table_number=$1`, [String(n)])).rows[0].id as string;

test('1. every QR resolves to its own table; all share one menu', async () => {
  const menus: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await anon.get(`/public/tables/${tokens[i]}`);
    assert.equal(r.status, 200); assert.equal(r.body.table.number, String(i + 1));
  }
  const m = await anon.get('/public/menu'); menus.push(JSON.stringify(m.body));
  assert.equal(anon && (await anon.get('/public/tables/not-a-real-token-123456')).body.error.code, 'INVALID_QR_TOKEN');
  assert.equal((await anon.get('/public/tables/short')).body.error.code, 'INVALID_QR_TOKEN');
});

test('2-3. same session on rescans, even simultaneous first scans', async () => {
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => scan(tokens[1])));
  assert.equal(new Set(results.map((r) => r.sessionId)).size, 1);
  const open = (await db.query(`SELECT COUNT(*)::int AS n FROM table_sessions WHERE table_id=$1 AND status='OPEN'`, [await tableId(2)])).rows[0].n;
  assert.equal(open, 1);
});

test('4-9, 21. two orders, one queue, server prices, accept all', async () => {
  const { c, sessionId } = await scan(tokens[2]);
  const r1 = await order(c, sessionId, [{ menuItemId: chai, quantity: 2 }, { menuItemId: coffee, quantity: 1, notes: 'no sugar' }]);
  assert.equal(r1.status, 201); assert.equal(r1.body.order.orderNumber, 1);
  const r2 = await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }]);
  assert.equal(r2.body.order.orderNumber, 2);
  // client-sent price is ignored (extra fields stripped by schema)
  const view = await mgr.get(`/tables/${await tableId(3)}/session`);
  assert.equal(view.body.orders.length, 2);
  assert.equal(view.body.bill.total, '0.00'); // nothing accepted yet
  const o1 = view.body.orders[0];
  assert.equal((await mgr.post(`/orders/${o1.id}/accept`)).status, 200);
  const after = await mgr.get(`/tables/${await tableId(3)}/session`);
  assert.ok(after.body.orders[0].items.every((i: any) => i.status === 'ACCEPTED'));
  // 2*30 + 100 = 160 ; tax 3.00 + 18.00 = 21.00 ; total 181.00
  assert.equal(after.body.bill.subtotal, '160.00'); assert.equal(after.body.bill.taxTotal, '21.00'); assert.equal(after.body.bill.total, '181.00');
  assert.equal((await mgr.post(`/orders/${o1.id}/accept`)).body.error.code, 'ORDER_ALREADY_PROCESSED');
});

test('8. idempotency key creates only one order', async () => {
  const { c, sessionId } = await scan(tokens[3]);
  const a = await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }], 'same-key-12345');
  const b = await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }], 'same-key-12345');
  assert.equal(a.body.order.id, b.body.order.id); assert.equal(b.body.duplicate, true);
  const n = (await db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE session_id=$1`, [sessionId])).rows[0].n;
  assert.equal(n, 1);
});

test('10-12, 14-15. item-level accept/reject/serve rules', async () => {
  const { c, sessionId } = await scan(tokens[4]);
  const created = await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }, { menuItemId: coffee, quantity: 1 }]);
  const oid = created.body.order.id; const [i1, i2] = created.body.order.items.map((i: any) => i.id);
  assert.equal((await mgr.post(`/orders/${oid}/items/${i1}/accept`)).status, 200);
  let o = (await mgr.get(`/orders/${oid}`)).body.order;
  assert.equal(o.status, 'PARTIALLY_ACCEPTED');
  assert.equal((await mgr.post(`/orders/${oid}/items/${i2}/reject`, {})).body.error.code, 'REJECTION_REASON_REQUIRED');
  assert.equal((await staff.post(`/orders/${oid}/items/${i2}/served`)).body.error.code, 'INVALID_STATUS_TRANSITION'); // pending
  assert.equal((await mgr.post(`/orders/${oid}/items/${i2}/reject`, { reason: 'Out of stock' })).status, 200);
  assert.equal((await staff.post(`/orders/${oid}/items/${i2}/served`)).body.error.code, 'INVALID_STATUS_TRANSITION'); // rejected
  assert.equal((await staff.post(`/orders/${oid}/items/${i1}/served`)).status, 200);
  assert.equal((await mgr.post(`/orders/${oid}/items/${i1}/reject`, { reason: 'x' })).body.error.code, 'INVALID_STATUS_TRANSITION'); // served
  o = (await mgr.get(`/orders/${oid}`)).body.order;
  assert.equal(o.status, 'SERVED');
  const bill = (await mgr.get(`/tables/${await tableId(5)}/session`)).body.bill;
  assert.equal(bill.total, '31.50'); // rejected coffee excluded; chai 30 + 1.50 tax
});

test('13, 17. staff cannot accept/reject/cancel or touch the menu', async () => {
  const { c, sessionId } = await scan(tokens[5]);
  const r = await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }]);
  const oid = r.body.order.id; const iid = r.body.order.items[0].id;
  for (const p of [`/orders/${oid}/accept`, `/orders/${oid}/reject`, `/orders/${oid}/cancel`, `/orders/${oid}/items/${iid}/accept`, `/orders/${oid}/items/${iid}/reject`]) {
    const x = await staff.post(p, { reason: 'x' }); assert.equal(x.status, 403, p); assert.equal(x.body.error.code, 'FORBIDDEN');
  }
  assert.equal((await staff.post('/menu/sections', { name: 'Nope' })).status, 403);
  assert.equal((await staff.patch(`/menu/items/${chai}`, { price: '1' })).status, 403);
  assert.equal((await staff.get('/users')).status, 403);
  assert.equal((await staff.get('/audit-logs')).status, 403);
  assert.equal((await staff.post(`/tables/${await tableId(6)}/regenerate-qr`)).status, 403);
  assert.equal((await anon.get('/tables')).status, 401);
  // staff may not change status via PATCH
  assert.equal((await staff.patch(`/orders/${oid}/items/${iid}`, { status: 'SERVED' })).status, 422);
});

test('18-20. menu changes reach customers; snapshots keep old prices; unavailable items blocked', async () => {
  const { c, sessionId } = await scan(tokens[6]);
  const un = await order(c, sessionId, [{ menuItemId: cake, quantity: 1 }]);
  assert.equal(un.status, 409); assert.equal(un.body.error.code, 'MENU_ITEM_UNAVAILABLE');
  const created = await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }]);
  await mgr.post(`/orders/${created.body.order.id}/accept`);
  assert.equal((await mgr.patch(`/menu/items/${chai}`, { price: '45' })).status, 200);
  const m = (await anon.get('/public/menu')).body;
  assert.equal(m.sections[0].items.find((i: any) => i.id === chai).price, '45.00');
  const bill = (await mgr.get(`/tables/${await tableId(7)}/session`)).body.bill;
  assert.equal(bill.subtotal, '30.00'); // still the old snapshot
  await mgr.patch(`/menu/items/${chai}`, { price: '30' }); // restore
  // hidden items disappear from the public menu
  await mgr.post(`/menu/items/${coffee}/deactivate`);
  const m2 = (await anon.get('/public/menu')).body;
  assert.ok(!m2.sections[0].items.some((i: any) => i.id === coffee));
  await mgr.patch(`/menu/items/${coffee}`, { isActive: true });
  assert.equal((await mgr.post('/menu/sections', { name: '  ' })).status, 422);
  assert.equal((await mgr.post('/menu/items', { sectionId: (await db.query('SELECT id FROM menu_sections LIMIT 1')).rows[0].id, name: 'Bad', foodType: 'VEG', price: '-5', taxRate: 5 })).status, 422);
});

test('22-30. payments, split, overpay, closing rules, new session after close', async () => {
  const t = await tableId(8);
  const { c, sessionId } = await scan(tokens[7]);
  const o = await order(c, sessionId, [{ menuItemId: coffee, quantity: 2 }]); // 200 + 36 = 236
  const oid = o.body.order.id;
  let bill = (await mgr.get(`/tables/${t}/session`)).body.bill;
  const closeBefore = await mgr.post(`/bills/${bill.id}/close`);
  assert.equal(closeBefore.body.error.code, 'PENDING_ITEMS_REMAIN');
  await mgr.post(`/orders/${oid}/accept`);
  bill = (await mgr.get(`/tables/${t}/session`)).body.bill;
  assert.equal(bill.total, '236.00');
  assert.equal((await mgr.post(`/bills/${bill.id}/close`)).body.error.code, 'BILL_HAS_BALANCE');
  assert.equal((await staff.post(`/bills/${bill.id}/payments`, { method: 'CASH', amount: '10' })).status, 403);
  assert.equal((await mgr.post(`/bills/${bill.id}/payments`, { method: 'CASH', amount: '500' })).body.error.code, 'PAYMENT_EXCEEDS_BALANCE');
  assert.equal((await mgr.post(`/bills/${bill.id}/payments`, { method: 'CASH', amount: '0' })).status, 422);
  const p1 = await mgr.post(`/bills/${bill.id}/payments`, { method: 'CASH', amount: '100', idempotencyKey: 'pay-key-0001' });
  const dup = await mgr.post(`/bills/${bill.id}/payments`, { method: 'CASH', amount: '100', idempotencyKey: 'pay-key-0001' });
  assert.equal(dup.body.paymentId, p1.body.paymentId);
  bill = (await mgr.get(`/tables/${t}/session`)).body.bill;
  assert.equal(bill.amountPaid, '100.00'); assert.equal(bill.balanceDue, '136.00'); assert.equal(bill.status, 'PARTIALLY_PAID');
  // staff view never shows payments
  const sb = (await staff.get(`/tables/${t}/session`)).body.bill;
  assert.equal(sb.payments, undefined); assert.equal(sb.amountPaid, undefined);
  assert.equal((await mgr.post(`/bills/${bill.id}/payments`, { method: 'UPI', amount: '136.00', referenceNumber: 'UPI123' })).status, 201);
  bill = (await mgr.get(`/tables/${t}/session`)).body.bill;
  assert.equal(bill.status, 'PAID'); assert.equal(bill.balanceDue, '0.00');
  assert.equal(bill.payments.find((p: any) => p.method === 'UPI').referenceNumber, 'UPI123');
  // 28/29/30: close, new session, old session can't take orders
  assert.equal((await mgr.post(`/bills/${bill.id}/close`)).status, 200);
  assert.equal((await mgr.post(`/bills/${bill.id}/close`)).body.error.code, 'BILL_ALREADY_CLOSED');
  const late = await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }]);
  assert.equal(late.status, 409); assert.equal(late.body.error.code, 'SESSION_CLOSED');
  assert.equal((await c.get(`/public/sessions/${sessionId}`)).body.error.code, 'SESSION_CLOSED');
  const next = await scan(tokens[7]);
  assert.notEqual(next.sessionId, sessionId); assert.equal(next.status, 201);
  const nb = (await mgr.get(`/tables/${t}/session`)).body.bill;
  assert.notEqual(nb.billNumber, bill.billNumber); assert.equal(nb.total, '0.00');
});

test('void payment, then rebalance', async () => {
  const t = await tableId(9);
  const { c, sessionId } = await scan(tokens[8]);
  const o = await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }]);
  await mgr.post(`/orders/${o.body.order.id}/accept`);
  let bill = (await mgr.get(`/tables/${t}/session`)).body.bill;
  const p = await mgr.post(`/bills/${bill.id}/payments`, { method: 'UPI', amount: '31.50' });
  assert.equal((await mgr.post(`/payments/${p.body.paymentId}/void`, {})).status, 422); // reason required
  assert.equal((await mgr.post(`/payments/${p.body.paymentId}/void`, { reason: 'UPI never arrived' })).status, 200);
  bill = (await mgr.get(`/tables/${t}/session`)).body.bill;
  assert.equal(bill.amountPaid, '0.00'); assert.equal(bill.balanceDue, '31.50'); assert.equal(bill.status, 'OPEN');
});

test('staff can add an order for a table; it is PENDING and notifies', async () => {
  const t = await tableId(10);
  const start = await staff.post(`/tables/${t}/session`);
  assert.equal(start.status, 201);
  assert.equal((await staff.post(`/tables/${t}/session`)).body.error.code, 'TABLE_ALREADY_HAS_OPEN_SESSION');
  const r = await staff.post(`/staff/sessions/${start.body.sessionId}/orders`, { idempotencyKey: 'staff-key-001', items: [{ menuItemId: chai, quantity: 3 }] });
  assert.equal(r.status, 201);
  const view = (await staff.get(`/tables/${t}/session`)).body;
  assert.equal(view.orders[0].source, 'STAFF'); assert.equal(view.orders[0].status, 'PENDING');
  // staff may edit pending item but not an accepted one
  const iid = view.orders[0].items[0].id;
  assert.equal((await staff.patch(`/orders/${r.body.orderId}/items/${iid}`, { quantity: 2, notes: 'extra hot' })).status, 200);
  await mgr.post(`/orders/${r.body.orderId}/accept`);
  assert.equal((await staff.patch(`/orders/${r.body.orderId}/items/${iid}`, { quantity: 1 })).body.error.code, 'INVALID_STATUS_TRANSITION');
  assert.equal((await mgr.patch(`/orders/${r.body.orderId}/items/${iid}`, { quantity: 1 })).body.error.code, 'REJECTION_REASON_REQUIRED');
  assert.equal((await mgr.patch(`/orders/${r.body.orderId}/items/${iid}`, { quantity: 1, reason: 'Customer changed mind' })).status, 200);
  // order-level served is blocked while pending items exist
  const n = (await mgr.get('/notifications?unread=true')).body.notifications;
  assert.ok(n.some((x: any) => x.message.includes('New order for Table 10')));
  assert.equal((await mgr.post('/notifications/read-all')).status, 200);
  assert.equal((await mgr.get('/notifications?unread=true')).body.notifications.length, 0);
});

test('33. public API never leaks payments, staff names, audit or other sessions', async () => {
  const { c, sessionId } = await scan(tokens[8]);
  const body = JSON.stringify((await c.get(`/public/sessions/${sessionId}`)).body);
  for (const word of ['payment', 'createdByName', 'amountPaid', 'audit', 'Mia', 'Sam']) assert.ok(!body.includes(word), word);
  const other = await scan(tokens[0]);
  assert.equal((await c.get(`/public/sessions/${other.sessionId}`)).status, 403); // token is bound to its own session
  assert.equal((await anon.get(`/public/sessions/${sessionId}`)).status, 403);
});

test('31. audit log records privileged actions and cannot be edited', async () => {
  const log = (await mgr.get('/audit-logs')).body.entries.map((e: any) => e.action);
  for (const a of ['ORDER_ACCEPTED', 'ITEM_REJECTED', 'ITEM_SERVED', 'PAYMENT_RECORDED', 'PAYMENT_VOIDED', 'SESSION_CLOSED', 'MENU_ITEM_PRICE_CHANGED', 'ITEM_EDITED'])
    assert.ok(log.includes(a), a);
  await assert.rejects(() => db.query(`UPDATE audit_logs SET action='x'`));
  await assert.rejects(() => db.query(`DELETE FROM audit_logs`));
});

test('reports use server totals', async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const p = (await mgr.get(`/reports/daily-payments?date=${today}`)).body;
  assert.equal(p.closedBills, 1);
  assert.ok(Number(p.netAmount) >= 236);
  assert.equal((await mgr.get('/reports/daily-sales?date=bad')).status, 422);
  assert.equal((await mgr.get(`/reports/daily-sales?date=${today}`)).status, 200);
});

test('security: login throttling and cross-origin writes', async () => {
  const x = client(base);
  for (let i = 0; i < 5; i++) assert.equal((await x.post('/auth/login', { username: 'staff', password: 'wrong' })).status, 401);
  assert.equal((await x.post('/auth/login', { username: 'staff', password: 'password123' })).status, 429);
  const r = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('6-7. live event reaches manager AND staff; staff never get payment events; missed orders stay as unread notifications', async () => {
  const listen = async (cookieClient: string) => {
    const ctl = new AbortController(); let text = '';
    const r = await fetch(`${base}/events`, { headers: { cookie: cookieClient }, signal: ctl.signal });
    (async () => { const rd = r.body!.getReader(); const d = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; text += d.decode(value); } })().catch(() => {});
    return { stop: () => ctl.abort(), text: () => text };
  };
  const m = await listen(mgr.cookie()); const s = await listen(staff.cookie());
  await new Promise((r) => setTimeout(r, 400));
  const { c, sessionId } = await scan(tokens[0]);
  await order(c, sessionId, [{ menuItemId: chai, quantity: 1 }]);
  for (let i = 0; i < 50 && !(m.text().includes('event: bill.updated') && s.text().includes('event: table.updated')); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(m.text().includes('event: order.created') && s.text().includes('event: order.created'));
  assert.ok(m.text().includes('"tableNumber":"1"'));
  assert.ok(m.text().includes('event: bill.updated')); assert.ok(!s.text().includes('event: bill.updated'));
  m.stop(); s.stop();
  // someone who was offline still finds the unread notification after reconnecting
  const n = (await staff.get('/notifications?unread=true')).body.notifications;
  assert.ok(n.some((x: any) => x.message.includes('Table 1')));
});
