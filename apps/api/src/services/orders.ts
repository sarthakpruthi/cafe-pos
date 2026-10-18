import { db, withTx, type Q, type Emit } from '../db.js';
import { AppError } from '../errors.js';
import { audit } from '../audit.js';
import { recalcBill } from './billing.js';
import type { Actor } from './menu.js';

export type ItemStatus = 'PENDING' | 'ACCEPTED' | 'SERVED' | 'REJECTED' | 'CANCELLED';

/**
 * The ONE place that decides an order's overall status from its item statuses.
 * Rejected/cancelled items never count as "active". Once nothing is pending,
 * the order shows its progress (ACCEPTED / PARTIALLY_SERVED / SERVED); the item rows
 * keep the authoritative detail (including which items were rejected).
 */
export function computeOrderStatus(items: ItemStatus[]): string {
  const rejected = items.filter((s) => s === 'REJECTED').length;
  const cancelled = items.filter((s) => s === 'CANCELLED').length;
  const active = items.filter((s) => s !== 'REJECTED' && s !== 'CANCELLED');
  if (items.length === 0) return 'PENDING';
  if (active.length === 0) return cancelled > 0 ? 'CANCELLED' : 'REJECTED';
  const pending = active.filter((s) => s === 'PENDING').length;
  const served = active.filter((s) => s === 'SERVED').length;
  if (pending === active.length) return rejected + cancelled > 0 ? 'PARTIALLY_REJECTED' : 'PENDING';
  if (pending > 0) return 'PARTIALLY_ACCEPTED';
  if (served === active.length) return 'SERVED';
  if (served > 0) return 'PARTIALLY_SERVED';
  return 'ACCEPTED';
}

async function refreshOrderStatus(c: Q, orderId: string) {
  const items = (await c.query<{ status: ItemStatus }>(`SELECT status FROM order_items WHERE order_id=$1`, [orderId])).rows;
  const status = computeOrderStatus(items.map((i) => i.status));
  await c.query(`UPDATE orders SET status=$2, updated_at=now() WHERE id=$1`, [orderId, status]);
  return status;
}

// ------------------------------------------------------------------ sessions

/** Find the table's OPEN session, or create it (plus its bill) atomically. Concurrent scans get the same session. */
export async function getOrCreateSession(c: Q, emit: Emit, tableId: string, userId: string | null) {
  await c.query(`SELECT id FROM cafe_tables WHERE id=$1 FOR UPDATE`, [tableId]); // serialises scans per table
  const open = (await c.query(`SELECT id FROM table_sessions WHERE table_id=$1 AND status='OPEN'`, [tableId])).rows[0];
  if (open) return { id: open.id as string, created: false };
  const n = (await c.query(`SELECT COALESCE(MAX(session_number),0)+1 AS n FROM table_sessions WHERE table_id=$1`, [tableId])).rows[0].n;
  const s = (await c.query(
    `INSERT INTO table_sessions (table_id, session_number, opened_by_user_id) VALUES ($1,$2,$3) RETURNING id`,
    [tableId, n, userId])).rows[0];
  await c.query(
    `INSERT INTO bills (session_id, bill_number) VALUES ($1, 'B' || lpad(nextval('bill_number_seq')::text, 5, '0'))`, [s.id]);
  emit('session.opened', { tableId, sessionId: s.id }, { staff: true });
  emit('table.updated', { tableId }, { staff: true });
  return { id: s.id as string, created: true };
}

export async function startSessionManually(a: Actor, tableId: string) {
  return withTx(async (c, emit) => {
    const t = (await c.query(`SELECT 1 FROM cafe_tables WHERE id=$1 AND is_active`, [tableId])).rows[0];
    if (!t) throw new AppError('NOT_FOUND', 'Table not found.');
    const open = (await c.query(`SELECT 1 FROM table_sessions WHERE table_id=$1 AND status='OPEN'`, [tableId])).rows[0];
    if (open) throw new AppError('TABLE_ALREADY_HAS_OPEN_SESSION', 'This table is already in use.');
    const s = await getOrCreateSession(c, emit, tableId, a.id);
    await audit(c, { actor: a.id, action: 'SESSION_STARTED', entityType: 'table_session', entityId: s.id, requestId: a.requestId });
    return s.id;
  });
}

// ------------------------------------------------------------------ creating orders

export interface NewOrder {
  sessionId: string;
  items: Array<{ menuItemId: string; quantity: number; notes?: string | null }>;
  customerNote?: string | null;
  idempotencyKey?: string | null;
  source: 'CUSTOMER_QR' | 'STAFF';
  userId?: string | null;
  requestId?: string;
}

export async function createOrder(o: NewOrder) {
  if (!o.items.length) throw new AppError('VALIDATION_ERROR', 'Please add at least one item.');
  for (const i of o.items)
    if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 50)
      throw new AppError('INVALID_QUANTITY', 'Quantity must be a whole number from 1 to 50.');

  return withTx(async (c, emit) => {
    const s = (await c.query(
      `SELECT s.id, s.status, s.table_id, t.table_number FROM table_sessions s JOIN cafe_tables t ON t.id=s.table_id
       WHERE s.id=$1 FOR UPDATE OF s`, [o.sessionId])).rows[0];
    if (!s) throw new AppError('SESSION_NOT_FOUND', 'We could not find this table session.');
    if (s.status !== 'OPEN') throw new AppError('SESSION_CLOSED', 'This table session is closed. Refresh the QR menu to continue.');

    if (o.idempotencyKey) {
      const dup = (await c.query(`SELECT id FROM orders WHERE session_id=$1 AND idempotency_key=$2`, [o.sessionId, o.idempotencyKey])).rows[0];
      if (dup) return { orderId: dup.id as string, duplicate: true };
    }

    // Prices and tax always come from the database, never from the client.
    const ids = [...new Set(o.items.map((i) => i.menuItemId))];
    const menu = (await c.query(
      `SELECT i.id, i.name, i.food_type, i.price, i.tax_rate, i.is_available, i.is_active AND s.is_active AS active
       FROM menu_items i JOIN menu_sections s ON s.id=i.section_id WHERE i.id = ANY($1::uuid[])`, [ids])).rows;
    const byId = new Map(menu.map((m: any) => [m.id, m]));
    for (const i of o.items) {
      const m: any = byId.get(i.menuItemId);
      if (!m || !m.active || !m.is_available)
        throw new AppError('MENU_ITEM_UNAVAILABLE',
          `${m ? m.name : 'An item'} is not available right now. Please remove it and try again.`, { menuItemId: i.menuItemId });
    }

    const num = (await c.query(`SELECT COALESCE(MAX(order_number),0)+1 AS n FROM orders WHERE session_id=$1`, [o.sessionId])).rows[0].n;
    const order = (await c.query(
      `INSERT INTO orders (session_id, order_number, source, customer_note, created_by_user_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [o.sessionId, num, o.source, o.customerNote?.trim() || null, o.userId ?? null, o.idempotencyKey ?? null])).rows[0];
    for (const [n, i] of o.items.entries()) {
      const m: any = byId.get(i.menuItemId);
      await c.query(
        `INSERT INTO order_items (order_id, line_number, menu_item_id, item_name_snapshot, food_type_snapshot, unit_price_snapshot, tax_rate_snapshot, quantity, notes)
         VALUES ($1,$9,$2,$3,$4,$5,$6,$7,$8)`,
        [order.id, m.id, m.name, m.food_type, m.price, m.tax_rate, i.quantity, i.notes?.trim() || null, n + 1]);
    }
    await refreshOrderStatus(c, order.id);
    await recalcBill(c, o.sessionId);

    const itemCount = o.items.reduce((n, i) => n + i.quantity, 0);
    const message = `New order for Table ${s.table_number} (Order #${num}, ${itemCount} ${itemCount === 1 ? 'item' : 'items'})`;
    const note = (await c.query(
      `INSERT INTO notifications (type, table_id, session_id, order_id, message) VALUES ('order.created',$1,$2,$3,$4) RETURNING id, created_at`,
      [s.table_id, o.sessionId, order.id, message])).rows[0];
    await audit(c, { actor: o.userId ?? null, action: o.source === 'STAFF' ? 'ORDER_CREATED_BY_STAFF' : 'ORDER_CREATED', entityType: 'order', entityId: order.id, newValue: { orderNumber: num, itemCount }, requestId: o.requestId });

    const payload = { tableId: s.table_id, tableNumber: s.table_number, sessionId: o.sessionId, orderId: order.id, orderNumber: num, itemCount, createdAt: note.created_at };
    emit('order.created', payload, { staff: true });
    emit('order.created', { orderId: order.id, orderNumber: num }, { sessionId: o.sessionId });
    emit('notification.created', { notificationId: note.id, message, ...payload }, { staff: true });
    emit('table.updated', { tableId: s.table_id }, { staff: true });
    emit('bill.updated', { tableId: s.table_id, sessionId: o.sessionId }, { staff: true, managerOnly: true });
    return { orderId: order.id as string, duplicate: false };
  });
}

// ------------------------------------------------------------------ item / order actions

interface Ctx { c: Q; emit: Emit; a: Actor; sessionId: string; tableId: string; orderId: string; }

/** Locks the session, makes sure it is still open, and returns where the order lives. */
async function openCtx(c: Q, emit: Emit, a: Actor, orderId: string): Promise<Ctx> {
  const o = (await c.query(
    `SELECT o.session_id, s.table_id FROM orders o JOIN table_sessions s ON s.id=o.session_id WHERE o.id=$1`, [orderId])).rows[0];
  if (!o) throw new AppError('NOT_FOUND', 'Order not found.');
  const s = (await c.query(`SELECT status FROM table_sessions WHERE id=$1 FOR UPDATE`, [o.session_id])).rows[0];
  if (s.status !== 'OPEN') throw new AppError('SESSION_CLOSED', 'This table has already been closed, so its orders can no longer be changed.');
  return { c, emit, a, sessionId: o.session_id, tableId: o.table_id, orderId };
}

async function finish(x: Ctx, action: string, itemIds: string[], reason: string | null, event: string) {
  const status = await refreshOrderStatus(x.c, x.orderId);
  await recalcBill(x.c, x.sessionId);
  x.emit(event, { tableId: x.tableId, orderId: x.orderId, status }, { staff: true });
  x.emit('order.updated', { tableId: x.tableId, orderId: x.orderId, status }, { sessionId: x.sessionId });
  x.emit('order_item.updated', { tableId: x.tableId, orderId: x.orderId, itemIds }, { staff: true });
  x.emit('table.updated', { tableId: x.tableId }, { staff: true });
  x.emit('bill.updated', { tableId: x.tableId, sessionId: x.sessionId }, { staff: true, managerOnly: true });
  await audit(x.c, { actor: x.a.id, action, entityType: 'order', entityId: x.orderId, newValue: { itemIds }, reason, requestId: x.a.requestId });
}

async function setStatus(x: Ctx, ids: string[], status: ItemStatus, reason: string | null) {
  await x.c.query(
    `UPDATE order_items SET status=$2, rejection_reason=$3, status_updated_by_user_id=$4, status_updated_at=now(), updated_at=now() WHERE id = ANY($1::uuid[])`,
    [ids, status, reason, x.a.id]);
}

const needReason = (r?: string | null) => {
  if (!r || !r.trim()) throw new AppError('REJECTION_REASON_REQUIRED', 'Please tell us why (for example: "Out of stock").');
  return r.trim();
};

async function loadItems(c: Q, orderId: string, itemId?: string) {
  const rows = (await c.query<{ id: string; item_name_snapshot: string; status: ItemStatus }>(
    `SELECT id, item_name_snapshot, status FROM order_items WHERE order_id=$1 ${itemId ? 'AND id=$2' : ''} ORDER BY line_number, id`,
    itemId ? [orderId, itemId] : [orderId])).rows;
  if (itemId && !rows.length) throw new AppError('NOT_FOUND', 'Item not found.');
  return rows;
}
const badMove = (name: string, status: string, verb: string) =>
  new AppError('INVALID_STATUS_TRANSITION', `${name} is already ${status.toLowerCase()}, so it cannot be ${verb}.`);

// ---- manager: accept / reject / cancel

export const acceptOrder = (a: Actor, orderId: string) => withTx(async (c, emit) => {
  const x = await openCtx(c, emit, a, orderId);
  const ids = (await loadItems(c, orderId)).filter((i) => i.status === 'PENDING').map((i) => i.id);
  if (!ids.length) throw new AppError('ORDER_ALREADY_PROCESSED', 'There is nothing waiting in this order.');
  await setStatus(x, ids, 'ACCEPTED', null);
  await finish(x, 'ORDER_ACCEPTED', ids, null, 'order.accepted');
});

export const rejectOrder = (a: Actor, orderId: string, reason?: string | null) => withTx(async (c, emit) => {
  const why = needReason(reason);
  const x = await openCtx(c, emit, a, orderId);
  const ids = (await loadItems(c, orderId)).filter((i) => i.status === 'PENDING').map((i) => i.id);
  if (!ids.length) throw new AppError('ORDER_ALREADY_PROCESSED', 'There is nothing waiting in this order. Reject or cancel items one by one instead.');
  await setStatus(x, ids, 'REJECTED', why);
  await finish(x, 'ORDER_REJECTED', ids, why, 'order.rejected');
});

export const acceptItem = (a: Actor, orderId: string, itemId: string) => withTx(async (c, emit) => {
  const x = await openCtx(c, emit, a, orderId);
  const [it] = await loadItems(c, orderId, itemId);
  if (it.status !== 'PENDING') throw badMove(it.item_name_snapshot, it.status, 'accepted');
  await setStatus(x, [itemId], 'ACCEPTED', null);
  await finish(x, 'ITEM_ACCEPTED', [itemId], null, 'order.updated');
});

export const rejectItem = (a: Actor, orderId: string, itemId: string, reason?: string | null) => withTx(async (c, emit) => {
  const why = needReason(reason);
  const x = await openCtx(c, emit, a, orderId);
  const [it] = await loadItems(c, orderId, itemId);
  if (it.status !== 'PENDING')
    throw new AppError('INVALID_STATUS_TRANSITION', `${it.item_name_snapshot} is already ${it.status.toLowerCase()}. Use "Cancel item" to remove an item that was already confirmed.`);
  await setStatus(x, [itemId], 'REJECTED', why);
  await finish(x, 'ITEM_REJECTED', [itemId], why, 'order.updated');
});

export const cancelItem = (a: Actor, orderId: string, itemId: string, reason?: string | null) => withTx(async (c, emit) => {
  const why = needReason(reason);
  const x = await openCtx(c, emit, a, orderId);
  const [it] = await loadItems(c, orderId, itemId);
  if (it.status !== 'PENDING' && it.status !== 'ACCEPTED') throw badMove(it.item_name_snapshot, it.status, 'cancelled');
  await setStatus(x, [itemId], 'CANCELLED', why);
  await finish(x, 'ITEM_CANCELLED', [itemId], why, 'order.updated');
});

export const cancelOrder = (a: Actor, orderId: string, reason?: string | null) => withTx(async (c, emit) => {
  const why = needReason(reason);
  const x = await openCtx(c, emit, a, orderId);
  const ids = (await loadItems(c, orderId)).filter((i) => i.status === 'PENDING' || i.status === 'ACCEPTED').map((i) => i.id);
  if (!ids.length) throw new AppError('ORDER_ALREADY_PROCESSED', 'There is nothing left in this order to cancel.');
  await setStatus(x, ids, 'CANCELLED', why);
  await finish(x, 'ORDER_CANCELLED', ids, why, 'order.updated');
});

// ---- staff or manager: served

export const serveItem = (a: Actor, orderId: string, itemId: string) => withTx(async (c, emit) => {
  const x = await openCtx(c, emit, a, orderId);
  const [it] = await loadItems(c, orderId, itemId);
  if (it.status !== 'ACCEPTED')
    throw new AppError('INVALID_STATUS_TRANSITION',
      it.status === 'PENDING' ? `${it.item_name_snapshot} has not been accepted by the manager yet.` : `${it.item_name_snapshot} is ${it.status.toLowerCase()}, so it cannot be marked served.`);
  await setStatus(x, [itemId], 'SERVED', null);
  await finish(x, 'ITEM_SERVED', [itemId], null, 'order.updated');
});

export const serveOrder = (a: Actor, orderId: string) => withTx(async (c, emit) => {
  const x = await openCtx(c, emit, a, orderId);
  const items = await loadItems(c, orderId);
  const live = items.filter((i) => i.status !== 'REJECTED' && i.status !== 'CANCELLED');
  const waiting = live.filter((i) => i.status === 'PENDING');
  if (waiting.length)
    throw new AppError('INVALID_STATUS_TRANSITION',
      `Some items are still waiting for the manager: ${waiting.map((i) => i.item_name_snapshot).join(', ')}.`,
      { items: waiting.map((i) => i.item_name_snapshot) });
  const ids = live.filter((i) => i.status === 'ACCEPTED').map((i) => i.id);
  if (!ids.length) throw new AppError('ORDER_ALREADY_PROCESSED', 'Everything in this order is already served.');
  await setStatus(x, ids, 'SERVED', null);
  await finish(x, 'ORDER_SERVED', ids, null, 'order.served');
});

// ---- edit an item (quantity / notes)

export const editItem = (a: Actor, orderId: string, itemId: string, d: { quantity?: number; notes?: string | null; reason?: string | null }) =>
  withTx(async (c, emit) => {
    if (d.quantity !== undefined && (!Number.isInteger(d.quantity) || d.quantity < 1 || d.quantity > 50))
      throw new AppError('INVALID_QUANTITY', 'Quantity must be a whole number from 1 to 50.');
    const x = await openCtx(c, emit, a, orderId);
    const it = (await c.query(`SELECT * FROM order_items WHERE id=$1 AND order_id=$2`, [itemId, orderId])).rows[0];
    if (!it) throw new AppError('NOT_FOUND', 'Item not found.');
    const editable = a.role === 'MANAGER' ? ['PENDING', 'ACCEPTED'] : ['PENDING'];
    if (!editable.includes(it.status))
      throw new AppError('INVALID_STATUS_TRANSITION',
        a.role === 'STAFF' && it.status === 'ACCEPTED' ? 'This item was already accepted. Please ask the manager to change it.' : `This item is ${it.status.toLowerCase()} and can no longer be changed.`);
    if (it.status === 'ACCEPTED') needReason(d.reason);
    await c.query(`UPDATE order_items SET quantity=COALESCE($2,quantity), notes=CASE WHEN $3::boolean THEN $4 ELSE notes END, updated_at=now() WHERE id=$1`,
      [itemId, d.quantity ?? null, d.notes !== undefined, d.notes?.trim() || null]);
    await audit(c, { actor: a.id, action: 'ITEM_EDITED', entityType: 'order_item', entityId: itemId,
      oldValue: { quantity: it.quantity, notes: it.notes }, newValue: { quantity: d.quantity ?? it.quantity, notes: d.notes ?? it.notes }, reason: d.reason ?? null, requestId: a.requestId });
    await recalcBill(c, x.sessionId);
    emit('order.updated', { tableId: x.tableId, orderId }, { staff: true });
    emit('order.updated', { tableId: x.tableId, orderId }, { sessionId: x.sessionId });
    emit('table.updated', { tableId: x.tableId }, { staff: true });
    emit('bill.updated', { tableId: x.tableId, sessionId: x.sessionId }, { staff: true, managerOnly: true });
  });

// ------------------------------------------------------------------ read models

const itemSelect = `oi.id, oi.order_id AS "orderId", oi.menu_item_id AS "menuItemId", oi.item_name_snapshot AS name,
  oi.food_type_snapshot AS "foodType", oi.unit_price_snapshot AS "unitPrice", oi.tax_rate_snapshot AS "taxRate",
  oi.quantity, oi.notes, oi.status, oi.rejection_reason AS "rejectionReason",
  (oi.unit_price_snapshot * oi.quantity) AS "lineSubtotal",
  ROUND(oi.unit_price_snapshot * oi.quantity * oi.tax_rate_snapshot / 100, 2) AS "lineTax"`;

export async function loadOrders(c: Q, sessionId: string, forCustomer: boolean) {
  const orders = (await c.query(
    `SELECT o.id, o.order_number AS "orderNumber", o.status, o.source, o.customer_note AS "customerNote",
            o.created_at AS "createdAt", u.name AS "createdByName"
     FROM orders o LEFT JOIN users u ON u.id=o.created_by_user_id WHERE o.session_id=$1 ORDER BY o.order_number`, [sessionId])).rows;
  const items = (await c.query(
    `SELECT ${itemSelect} FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.session_id=$1 ORDER BY oi.line_number, oi.id`, [sessionId])).rows;
  return orders.map((o: any) => {
    const mine = items.filter((i: any) => i.orderId === o.id).map((i: any) =>
      forCustomer ? { id: i.id, name: i.name, quantity: i.quantity, notes: i.notes, status: i.status, rejectionReason: i.rejectionReason } : i);
    const { createdByName, ...rest } = o; // staff names are never sent to customers
    return forCustomer ? { ...rest, items: mine } : { ...o, items: mine };
  });
}

export async function tableSummaries(role: 'MANAGER' | 'STAFF') {
  const rows = (await db.query(
    `SELECT t.id, t.table_number AS "tableNumber", t.display_name AS "displayName",
       s.id AS "sessionId", s.opened_at AS "openedAt",
       COALESCE((SELECT COUNT(*)::int FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.session_id=s.id AND oi.status='PENDING'),0) AS "pendingItems",
       COALESCE((SELECT COUNT(DISTINCT o.id)::int FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.session_id=s.id AND oi.status='PENDING'),0) AS "pendingOrders",
       COALESCE((SELECT COUNT(*)::int FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.session_id=s.id AND oi.status='ACCEPTED'),0) AS "toServe",
       (SELECT MAX(GREATEST(o.updated_at, o.created_at)) FROM orders o WHERE o.session_id=s.id) AS "lastActivityAt",
       b.total, b.amount_paid AS "amountPaid", b.balance_due AS "balanceDue"
     FROM cafe_tables t
     LEFT JOIN table_sessions s ON s.table_id=t.id AND s.status='OPEN'
     LEFT JOIN bills b ON b.session_id=s.id
     WHERE t.is_active ORDER BY length(t.table_number), t.table_number`)).rows;
  return rows.map((r: any) => {
    const base = { ...r, occupied: !!r.sessionId };
    if (role === 'MANAGER') return base;
    const { total, amountPaid, balanceDue, ...staffView } = base; // staff do not see money on the grid
    return staffView;
  });
}

export async function tableSession(tableId: string, role: 'MANAGER' | 'STAFF') {
  const t = (await db.query(
    `SELECT id, table_number AS "tableNumber", display_name AS "displayName" FROM cafe_tables WHERE id=$1 AND is_active`, [tableId])).rows[0];
  if (!t) throw new AppError('NOT_FOUND', 'Table not found.');
  const s = (await db.query(
    `SELECT id, session_number AS "sessionNumber", status, opened_at AS "openedAt" FROM table_sessions WHERE table_id=$1 AND status='OPEN'`, [tableId])).rows[0];
  if (!s) return { table: t, session: null, orders: [], bill: null };
  const orders = await loadOrders(db, s.id, false);
  const bill = await billView(db, s.id, role);
  return { table: t, session: s, orders, bill };
}

/** Bill as shown to staff (totals only) or manager (everything incl. payments). */
export async function billView(c: Q, sessionId: string, role: 'MANAGER' | 'STAFF') {
  const b = (await c.query(
    `SELECT id, bill_number AS "billNumber", subtotal, tax_total AS "taxTotal", discount_total AS "discountTotal", total,
            amount_paid AS "amountPaid", balance_due AS "balanceDue", status FROM bills WHERE session_id=$1`, [sessionId])).rows[0];
  if (!b) throw new AppError('BILL_NOT_FOUND', 'No bill found for this table.');
  const pend = (await c.query(
    `SELECT COALESCE(SUM(oi.unit_price_snapshot*oi.quantity + ROUND(oi.unit_price_snapshot*oi.quantity*oi.tax_rate_snapshot/100,2)),0) AS v
     FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.session_id=$1 AND oi.status='PENDING'`, [sessionId])).rows[0];
  const base = { subtotal: b.subtotal, taxTotal: b.taxTotal, discountTotal: b.discountTotal, total: b.total, pendingValue: pend.v, status: b.status, billNumber: b.billNumber };
  if (role !== 'MANAGER') return base;
  const payments = (await c.query(
    `SELECT p.id, p.method, p.amount, p.status, p.reference_number AS "referenceNumber", p.notes, p.created_at AS "createdAt",
            p.void_reason AS "voidReason", u.name AS "recordedBy"
     FROM payments p JOIN users u ON u.id=p.recorded_by_user_id WHERE p.bill_id=$1 ORDER BY p.created_at`, [b.id])).rows;
  return { ...base, id: b.id, amountPaid: b.amountPaid, balanceDue: b.balanceDue, payments };
}
