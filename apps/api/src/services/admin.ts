import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { db, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { staffAuth } from '../supabase.js';
import type { Actor } from './menu.js';

// ------------------------------------------------------------------ users
export const listUsers = async (cafeId: string) => (await db.query(
  `SELECT id, name, username, role, is_active AS "isActive", last_login_at AS "lastLoginAt"
   FROM users WHERE cafe_id=$1 ORDER BY role, name`, [cafeId])).rows;

const strongEnough = (pw: string) => {
  if (pw.length < 8) throw new AppError('VALIDATION_ERROR', 'The password must be at least 8 characters long.');
};

export async function createUser(a: Actor, d: { name: string; username: string; password: string; role: 'MANAGER' | 'STAFF' }) {
  strongEnough(d.password);
  const username = d.username.trim();
  const cafe = (await db.query<{ emailDomain: string }>(
    `SELECT email_domain AS "emailDomain" FROM cafes WHERE id=$1`, [a.cafeId])).rows[0];
  if (!cafe) throw new AppError('NOT_FOUND', 'Cafe not found.');
  // Check locally first so a duplicate name never leaves a half-made account in Supabase.
  if ((await db.query(`SELECT 1 FROM users WHERE cafe_id=$1 AND lower(username)=lower($2)`, [a.cafeId, username])).rows.length)
    throw new AppError('VALIDATION_ERROR', 'That username is already taken in this cafe.');
  const authId = await staffAuth.create({ username, name: d.name.trim(), password: d.password, role: d.role, emailDomain: cafe.emailDomain });
  try {
    return await withTx(async (c) => {
      await c.query(`INSERT INTO users (id, name, username, role, cafe_id) VALUES ($1,$2,$3,$4,$5)`, [authId, d.name.trim(), username, d.role, a.cafeId]);
      await audit(c, { actor: a.id, action: 'USER_CREATED', entityType: 'user', entityId: authId, newValue: { username, role: d.role }, requestId: a.requestId });
      return authId;
    });
  } catch (e) {
    await staffAuth.remove(authId); // never leave a sign-in that has no profile
    throw e;
  }
}

export async function updateUser(a: Actor, id: string, d: { name?: string; role?: 'MANAGER' | 'STAFF'; isActive?: boolean; password?: string }) {
  if (d.password !== undefined) strongEnough(d.password);
  const u = (await db.query(`SELECT id, name, role, is_active FROM users WHERE id=$1 AND cafe_id=$2`, [id, a.cafeId])).rows[0];
  if (!u) throw new AppError('NOT_FOUND', 'User not found.');
  if (id === a.id && (d.isActive === false || (d.role && d.role !== 'MANAGER')))
    throw new AppError('VALIDATION_ERROR', 'You cannot switch off or demote your own account.');
  // Mirror the change in Supabase first, so a failed password reset does not leave the profile changed.
  if (d.password !== undefined) await staffAuth.setPassword(id, d.password);
  if (d.role) await staffAuth.setRole(id, d.role);
  if (d.isActive !== undefined) await staffAuth.setBanned(id, !d.isActive);
  await withTx(async (c) => {
    await c.query(`UPDATE users SET name=COALESCE($2,name), role=COALESCE($3,role), is_active=COALESCE($4,is_active), updated_at=now() WHERE id=$1`,
      [id, d.name?.trim() ?? null, d.role ?? null, d.isActive ?? null]);
    await audit(c, { actor: a.id, action: d.password ? 'USER_PASSWORD_RESET' : 'USER_UPDATED', entityType: 'user', entityId: id,
      oldValue: { name: u.name, role: u.role, isActive: u.is_active }, newValue: { name: d.name, role: d.role, isActive: d.isActive }, requestId: a.requestId });
  });
}

// ------------------------------------------------------------------ the manager's own cafe
// A manager is responsible for their own cafe and can see nothing of any other. New cafes are
// created by the operator (npm run cafe / the key-protected /setup page), never from inside the app.
const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cafe';

/** The signed-in person's own cafe — always scoped to their own cafe id. */
export async function getCafe(cafeId: string) {
  const c = (await db.query(
    `SELECT c.id, c.name, c.slug, c.email_domain AS "emailDomain", c.is_active AS "isActive", c.created_at AS "createdAt",
            (SELECT COUNT(*)::int FROM users u WHERE u.cafe_id=c.id) AS "staffCount",
            (SELECT COUNT(*)::int FROM users u WHERE u.cafe_id=c.id AND u.role='MANAGER') AS "managerCount"
     FROM cafes c WHERE c.id=$1`, [cafeId])).rows[0];
  if (!c) throw new AppError('NOT_FOUND', 'Cafe not found.');
  return c;
}

/**
 * Rename the signed-in manager's own cafe. The lookup and the update both use the actor's own cafe
 * id, so a manager can never read or change another cafe. The slug and sign-in domain stay fixed,
 * so nobody's login stops working.
 */
export async function updateCafe(a: Actor, d: { name: string }) {
  const name = d.name.trim();
  return withTx(async (c) => {
    const before = (await c.query<{ name: string }>(`SELECT name FROM cafes WHERE id=$1 FOR UPDATE`, [a.cafeId])).rows[0];
    if (!before) throw new AppError('NOT_FOUND', 'Cafe not found.');
    await c.query(`UPDATE cafes SET name=$2, updated_at=now() WHERE id=$1`, [a.cafeId, name]);
    await audit(c, { actor: a.id, action: 'CAFE_UPDATED', entityType: 'cafe', entityId: a.cafeId,
      oldValue: { name: before.name }, newValue: { name }, requestId: a.requestId });
    return { id: a.cafeId, name };
  });
}

export interface CafeSetup { name: string; managerName: string; username: string; password: string; }

/**
 * Creates a cafe and its first manager (a Supabase login). Only the operator runs this — through the
 * `npm run cafe` command or the key-protected /setup page — so it takes an optional actor rather
 * than requiring a signed-in manager. Managers cannot create cafes.
 */
export async function provisionCafe(d: CafeSetup, actorId: string | null, requestId?: string) {
  strongEnough(d.password);
  const name = d.name.trim();
  const managerName = d.managerName.trim();
  const username = d.username.trim();
  const slug = slugify(name);
  if ((await db.query(`SELECT 1 FROM cafes WHERE slug=$1`, [slug])).rows.length)
    throw new AppError('VALIDATION_ERROR', 'A cafe with a similar name already exists. Please use a slightly different name.');

  // Each cafe gets its own sign-in domain, so usernames may repeat across cafes.
  const emailDomain = `${slug}.${config.supabase.staffEmailDomain}`;
  const cafeId = (await db.query<{ id: string }>(
    `INSERT INTO cafes (name, slug, email_domain) VALUES ($1,$2,$3) RETURNING id`, [name, slug, emailDomain])).rows[0].id;

  let authId: string;
  try {
    authId = await staffAuth.create({ username, name: managerName, password: d.password, role: 'MANAGER', emailDomain });
  } catch (e) {
    await db.query(`DELETE FROM cafes WHERE id=$1`, [cafeId]); // never leave a cafe with no manager
    throw e;
  }
  try {
    await withTx(async (c) => {
      await c.query(`INSERT INTO users (id, name, username, role, cafe_id) VALUES ($1,$2,$3,'MANAGER',$4)`,
        [authId, managerName, username, cafeId]);
      await audit(c, { actor: actorId, action: 'CAFE_CREATED', entityType: 'cafe', entityId: cafeId,
        newValue: { name, slug, username }, requestId });
    });
  } catch (e) {
    await staffAuth.remove(authId);
    await db.query(`DELETE FROM cafes WHERE id=$1`, [cafeId]);
    throw e;
  }
  return { id: cafeId, name, slug, emailDomain };
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
