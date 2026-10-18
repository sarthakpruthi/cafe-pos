import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { db, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import type { Actor } from './menu.js';

// ------------------------------------------------------------------ users
export const listUsers = async () => (await db.query(
  `SELECT id, name, username, role, is_active AS "isActive", last_login_at AS "lastLoginAt" FROM users ORDER BY role, name`)).rows;

const strongEnough = (pw: string) => {
  if (pw.length < 8) throw new AppError('VALIDATION_ERROR', 'The password must be at least 8 characters long.');
};

export async function createUser(a: Actor, d: { name: string; username: string; password: string; role: 'MANAGER' | 'STAFF' }) {
  strongEnough(d.password);
  const hash = await bcrypt.hash(d.password, 10);
  return withTx(async (c) => {
    try {
      const r = await c.query(`INSERT INTO users (name, username, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id`,
        [d.name.trim(), d.username.trim(), hash, d.role]);
      await audit(c, { actor: a.id, action: 'USER_CREATED', entityType: 'user', entityId: r.rows[0].id, newValue: { username: d.username, role: d.role }, requestId: a.requestId });
      return r.rows[0].id as string;
    } catch (e: any) {
      if (String(e?.message).includes('users_username_lower')) throw new AppError('VALIDATION_ERROR', 'That username is already taken.');
      throw e;
    }
  });
}

export async function updateUser(a: Actor, id: string, d: { name?: string; role?: 'MANAGER' | 'STAFF'; isActive?: boolean; password?: string }) {
  if (d.password !== undefined) strongEnough(d.password);
  const hash = d.password ? await bcrypt.hash(d.password, 10) : null;
  return withTx(async (c) => {
    const u = (await c.query(`SELECT id, name, role, is_active FROM users WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!u) throw new AppError('NOT_FOUND', 'User not found.');
    if (id === a.id && (d.isActive === false || (d.role && d.role !== 'MANAGER')))
      throw new AppError('VALIDATION_ERROR', 'You cannot switch off or demote your own account.');
    await c.query(`UPDATE users SET name=COALESCE($2,name), role=COALESCE($3,role), is_active=COALESCE($4,is_active), password_hash=COALESCE($5,password_hash), updated_at=now() WHERE id=$1`,
      [id, d.name?.trim() ?? null, d.role ?? null, d.isActive ?? null, hash]);
    await audit(c, { actor: a.id, action: d.password ? 'USER_PASSWORD_RESET' : 'USER_UPDATED', entityType: 'user', entityId: id,
      oldValue: { name: u.name, role: u.role, isActive: u.is_active }, newValue: { name: d.name, role: d.role, isActive: d.isActive }, requestId: a.requestId });
  });
}

// ------------------------------------------------------------------ QR codes
export const newToken = () => randomBytes(18).toString('base64url');

export async function tableQr(tableId: string) {
  const t = (await db.query(`SELECT id, table_number, qr_token FROM cafe_tables WHERE id=$1 AND is_active`, [tableId])).rows[0];
  if (!t) throw new AppError('NOT_FOUND', 'Table not found.');
  const url = `${config.frontendUrl}/t/${t.qr_token}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 320, errorCorrectionLevel: 'M' });
  return { tableId: t.id, tableNumber: t.table_number, url, svg };
}

export async function allQrs() {
  const ids = (await db.query(`SELECT id FROM cafe_tables WHERE is_active ORDER BY length(table_number), table_number`)).rows;
  return Promise.all(ids.map((r: any) => tableQr(r.id)));
}

export async function regenerateQr(a: Actor, tableId: string) {
  return withTx(async (c) => {
    const t = (await c.query(`SELECT table_number FROM cafe_tables WHERE id=$1 FOR UPDATE`, [tableId])).rows[0];
    if (!t) throw new AppError('NOT_FOUND', 'Table not found.');
    await c.query(`UPDATE cafe_tables SET qr_token=$2, updated_at=now() WHERE id=$1`, [tableId, newToken()]);
    await audit(c, { actor: a.id, action: 'QR_REGENERATED', entityType: 'cafe_table', entityId: tableId, newValue: { tableNumber: t.table_number }, requestId: a.requestId });
  });
}

// ------------------------------------------------------------------ notifications & audit log
export async function listNotifications(userId: string, unreadOnly: boolean) {
  return (await db.query(
    `SELECT n.id, n.type, n.message, n.table_id AS "tableId", n.order_id AS "orderId", n.created_at AS "createdAt",
            (r.user_id IS NOT NULL) AS read
     FROM notifications n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=$1
     WHERE n.created_at > now() - interval '24 hours' ${unreadOnly ? 'AND r.user_id IS NULL' : ''}
     ORDER BY n.created_at DESC LIMIT 50`, [userId])).rows;
}
export const markRead = (userId: string, id: string) => db.query(
  `INSERT INTO notification_reads (notification_id, user_id) SELECT id, $1 FROM notifications WHERE id=$2 ON CONFLICT DO NOTHING`, [userId, id]);
export const markAllRead = (userId: string) => db.query(
  `INSERT INTO notification_reads (notification_id, user_id) SELECT id, $1 FROM notifications WHERE created_at > now() - interval '24 hours' ON CONFLICT DO NOTHING`, [userId]);

export async function listAudit(page: number, pageSize: number) {
  const rows = (await db.query(
    `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.reason, a.old_value AS "oldValue",
            a.new_value AS "newValue", a.created_at AS "createdAt", u.name AS "actorName"
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC, a.id LIMIT $1 OFFSET $2`,
    [pageSize + 1, (page - 1) * pageSize])).rows;
  return { page, pageSize, hasMore: rows.length > pageSize, entries: rows.slice(0, pageSize) };
}
