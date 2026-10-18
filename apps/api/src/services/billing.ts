import { db, withTx, type Q } from '../db.js';
import { AppError } from '../errors.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import type { Actor } from './menu.js';

/**
 * Recomputes the bill from saved item snapshots. Policy:
 *  - ACCEPTED and SERVED items are billable; PENDING, REJECTED and CANCELLED are not.
 *  - Prices are tax-EXCLUSIVE. Tax is rounded to 2 decimals per line (half up), then summed.
 *  - Balance = total - recorded (non-voided) payments.
 */
export async function recalcBill(c: Q, sessionId: string) {
  const r = await c.query(
    `WITH s AS (
       SELECT COALESCE(SUM(oi.unit_price_snapshot*oi.quantity),0) AS subtotal,
              COALESCE(SUM(ROUND(oi.unit_price_snapshot*oi.quantity*oi.tax_rate_snapshot/100,2)),0) AS tax
       FROM order_items oi JOIN orders o ON o.id=oi.order_id
       WHERE o.session_id=$1 AND oi.status IN ('ACCEPTED','SERVED')
     ), p AS (
       SELECT COALESCE(SUM(pay.amount),0) AS paid FROM payments pay JOIN bills b ON b.id=pay.bill_id
       WHERE b.session_id=$1 AND pay.status='RECORDED'
     )
     UPDATE bills SET subtotal=s.subtotal, tax_total=s.tax,
       total=s.subtotal+s.tax-discount_total, amount_paid=p.paid,
       balance_due=s.subtotal+s.tax-discount_total-p.paid,
       status = CASE WHEN status IN ('CLOSED','VOID') THEN status
                     WHEN p.paid>0 AND (s.subtotal+s.tax-discount_total-p.paid)<=0 THEN 'PAID'
                     WHEN p.paid>0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
       updated_at=now()
     FROM s, p WHERE bills.session_id=$1 RETURNING bills.*`, [sessionId]);
  return r.rows[0];
}

const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

async function lockBill(c: Q, billId: string) {
  const b = (await c.query(`SELECT id, session_id, status FROM bills WHERE id=$1`, [billId])).rows[0];
  if (!b) throw new AppError('BILL_NOT_FOUND', 'Bill not found.');
  const s = (await c.query(
    `SELECT s.id, s.table_id FROM table_sessions s WHERE s.id=$1 FOR UPDATE`, [b.session_id])).rows[0];
  const fresh = (await c.query(`SELECT status FROM bills WHERE id=$1`, [billId])).rows[0];
  if (fresh.status === 'CLOSED') throw new AppError('BILL_ALREADY_CLOSED', 'This bill is already closed.');
  return { bill: b, sessionId: s.id as string, tableId: s.table_id as string };
}

export async function recordPayment(a: Actor, billId: string, d: {
  method: 'CASH' | 'UPI'; amount: string; referenceNumber?: string | null; notes?: string | null; idempotencyKey?: string | null;
}) {
  if (!AMOUNT.test(d.amount) || Number(d.amount) <= 0)
    throw new AppError('VALIDATION_ERROR', 'Please enter an amount greater than zero, like 250 or 250.50.');
  return withTx(async (c, emit) => {
    const { sessionId, tableId } = await lockBill(c, billId);
    if (d.idempotencyKey) {
      const dup = (await c.query(`SELECT id FROM payments WHERE bill_id=$1 AND idempotency_key=$2`, [billId, d.idempotencyKey])).rows[0];
      if (dup) return { paymentId: dup.id as string, duplicate: true };
    }
    const bal = (await c.query(`SELECT balance_due, ($2::numeric > balance_due) AS over FROM bills WHERE id=$1`, [billId, d.amount])).rows[0];
    if (bal.over)
      throw new AppError('PAYMENT_EXCEEDS_BALANCE', `That is more than the balance due (${bal.balance_due}). Please enter ${bal.balance_due} or less.`, { balanceDue: bal.balance_due });
    const p = (await c.query(
      `INSERT INTO payments (bill_id, method, amount, reference_number, notes, idempotency_key, recorded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [billId, d.method, d.amount, d.referenceNumber?.trim() || null, d.notes?.trim() || null, d.idempotencyKey ?? null, a.id])).rows[0];
    await recalcBill(c, sessionId);
    await audit(c, { actor: a.id, action: 'PAYMENT_RECORDED', entityType: 'payment', entityId: p.id,
      newValue: { method: d.method, amount: d.amount, referenceNumber: d.referenceNumber ?? null }, requestId: a.requestId });
    emit('payment.recorded', { tableId, sessionId }, { staff: true, managerOnly: true });
    emit('bill.updated', { tableId, sessionId }, { staff: true, managerOnly: true });
    emit('table.updated', { tableId }, { staff: true });
    return { paymentId: p.id as string, duplicate: false };
  });
}

export async function voidPayment(a: Actor, paymentId: string, reason?: string | null) {
  if (!reason?.trim()) throw new AppError('VALIDATION_ERROR', 'Please give a reason for cancelling this payment.');
  return withTx(async (c, emit) => {
    const p = (await c.query(`SELECT id, bill_id, status, amount, method FROM payments WHERE id=$1`, [paymentId])).rows[0];
    if (!p) throw new AppError('NOT_FOUND', 'Payment not found.');
    const { sessionId, tableId } = await lockBill(c, p.bill_id);
    if (p.status === 'VOIDED') throw new AppError('INVALID_STATUS_TRANSITION', 'This payment was already cancelled.');
    await c.query(`UPDATE payments SET status='VOIDED', voided_at=now(), voided_by_user_id=$2, void_reason=$3 WHERE id=$1`, [paymentId, a.id, reason.trim()]);
    await recalcBill(c, sessionId);
    await audit(c, { actor: a.id, action: 'PAYMENT_VOIDED', entityType: 'payment', entityId: paymentId, oldValue: { amount: p.amount, method: p.method }, reason: reason.trim(), requestId: a.requestId });
    emit('payment.voided', { tableId, sessionId }, { staff: true, managerOnly: true });
    emit('bill.updated', { tableId, sessionId }, { staff: true, managerOnly: true });
    emit('table.updated', { tableId }, { staff: true });
  });
}

/** Closes the bill AND the table session in one transaction. */
export async function closeBill(a: Actor, billId: string) {
  return withTx(async (c, emit) => {
    const { sessionId, tableId } = await lockBill(c, billId);
    const sess = (await c.query(`SELECT status FROM table_sessions WHERE id=$1`, [sessionId])).rows[0];
    if (sess.status !== 'OPEN') throw new AppError('SESSION_CLOSED', 'This table is already closed.');
    const pending = (await c.query(
      `SELECT oi.item_name_snapshot AS name, o.order_number AS "orderNumber" FROM order_items oi JOIN orders o ON o.id=oi.order_id
       WHERE o.session_id=$1 AND oi.status='PENDING' ORDER BY o.order_number`, [sessionId])).rows;
    if (pending.length)
      throw new AppError('PENDING_ITEMS_REMAIN',
        `Some items are still waiting for your decision (${pending.map((p: any) => p.name).join(', ')}). Accept or reject them first.`, { items: pending });
    const b = await recalcBill(c, sessionId);
    if (Number(b.balance_due) !== 0)
      throw new AppError('BILL_HAS_BALANCE',
        Number(b.balance_due) > 0 ? `There is still ${b.balance_due} to pay. Record the payment first.` : `Payments are ${Math.abs(Number(b.balance_due)).toFixed(2)} more than the bill. Cancel the extra payment first.`,
        { balanceDue: b.balance_due });
    await c.query(`UPDATE bills SET status='CLOSED', closed_at=now(), closed_by_user_id=$2, updated_at=now() WHERE id=$1`, [billId, a.id]);
    await c.query(`UPDATE table_sessions SET status='CLOSED', closed_at=now(), closed_by_user_id=$2, updated_at=now() WHERE id=$1`, [sessionId, a.id]);
    await audit(c, { actor: a.id, action: 'SESSION_CLOSED', entityType: 'table_session', entityId: sessionId, newValue: { billId, total: b.total }, requestId: a.requestId });
    emit('session.closed', { tableId, sessionId }, { staff: true });
    emit('session.closed', { sessionId }, { sessionId });
    emit('table.updated', { tableId }, { staff: true });
    emit('bill.updated', { tableId, sessionId }, { staff: true, managerOnly: true });
  });
}

export async function getSessionBillId(sessionId: string) {
  const r = (await db.query(`SELECT id FROM bills WHERE session_id=$1`, [sessionId])).rows[0];
  if (!r) throw new AppError('BILL_NOT_FOUND', 'No bill found for this table.');
  return r.id as string;
}

// ------------------------------------------------------------------ reports (cafe-local day)

function checkDate(d: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new AppError('VALIDATION_ERROR', 'Please choose a valid date.');
}

export async function dailyPayments(date: string) {
  checkDate(date);
  const tz = config.timezone;
  const byMethod = (await db.query(
    `SELECT method, COUNT(*) FILTER (WHERE status='RECORDED')::int AS count,
            COALESCE(SUM(amount) FILTER (WHERE status='RECORDED'),0) AS received,
            COALESCE(SUM(amount) FILTER (WHERE status='VOIDED'),0) AS voided
     FROM payments WHERE (created_at AT TIME ZONE $2)::date = $1::date GROUP BY method ORDER BY method`, [date, tz])).rows;
  const bills = (await db.query(
    `SELECT COUNT(*)::int AS n FROM bills WHERE status='CLOSED' AND (closed_at AT TIME ZONE $2)::date = $1::date`, [date, tz])).rows[0].n;
  const net = (await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE status='RECORDED'),0) AS net, COALESCE(SUM(amount) FILTER (WHERE status='VOIDED'),0) AS voided,
            COUNT(*) FILTER (WHERE status='RECORDED')::int AS count
     FROM payments WHERE (created_at AT TIME ZONE $2)::date = $1::date`, [date, tz])).rows[0];
  return { date, timezone: tz, byMethod, paymentCount: net.count, voidedAmount: net.voided, netAmount: net.net, closedBills: bills };
}

export async function dailySales(date: string) {
  checkDate(date);
  const tz = config.timezone;
  const items = (await db.query(
    `SELECT oi.item_name_snapshot AS name, SUM(oi.quantity)::int AS quantity,
            SUM(oi.unit_price_snapshot*oi.quantity) AS subtotal,
            SUM(ROUND(oi.unit_price_snapshot*oi.quantity*oi.tax_rate_snapshot/100,2)) AS tax
     FROM order_items oi JOIN orders o ON o.id=oi.order_id
     WHERE oi.status IN ('ACCEPTED','SERVED') AND (o.created_at AT TIME ZONE $2)::date = $1::date
     GROUP BY oi.item_name_snapshot ORDER BY SUM(oi.quantity) DESC, oi.item_name_snapshot`, [date, tz])).rows;
  const bills = (await db.query(
    `SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE status='CLOSED')::int AS closed,
            COALESCE(SUM(subtotal),0) AS subtotal, COALESCE(SUM(tax_total),0) AS tax, COALESCE(SUM(discount_total),0) AS discounts, COALESCE(SUM(total),0) AS total
     FROM bills WHERE (created_at AT TIME ZONE $2)::date = $1::date`, [date, tz])).rows[0];
  const pay = await dailyPayments(date);
  return { date, bills, items, payments: pay.byMethod };
}
