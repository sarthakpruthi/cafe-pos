import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from './db.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { addClient, openStream } from './realtime.js';
import {
  authenticate as _a, requireAuth, requireManager, rateLimit, makeToken, readToken, COOKIE,
  loginLocked, loginFailed, loginOk,
} from './auth.js';
import * as menu from './services/menu.js';
import * as orders from './services/orders.js';
import * as billing from './services/billing.js';
import * as admin from './services/admin.js';
import { withTx } from './db.js';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

const actor = (req: Request) => ({ id: req.user!.id, role: req.user!.role, requestId: req.id });
const role = (req: Request) => req.user!.role;
const uuid = z.string().uuid();
const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => s.parse(v);
const id = (req: Request, name: string) => parse(uuid, req.params[name]);

const orderBody = z.object({
  idempotencyKey: z.string().min(8).max(100).optional(),
  items: z.array(z.object({
    menuItemId: uuid, quantity: z.number(), notes: z.string().max(300).nullish(),
  })).min(1).max(40),
  customerNote: z.string().max(500).nullish(),
});
const reasonBody = z.object({ reason: z.string().max(300).optional() });

export const router = Router();

// ---------------------------------------------------------------- auth
router.post('/auth/login', rateLimit('login', 30, 60_000), wrap(async (req, res) => {
  const { username, password } = parse(z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }), req.body);
  const key = `${req.ip}:${username.toLowerCase()}`;
  if (loginLocked(key)) throw new AppError('RATE_LIMITED', 'Too many wrong passwords. Please wait 10 minutes and try again.');
  const u = (await db.query(`SELECT id, name, username, role, password_hash, is_active FROM users WHERE lower(username)=lower($1)`, [username.trim()])).rows[0];
  const ok = u && u.is_active && await bcrypt.compare(password, u.password_hash);
  if (!ok) { loginFailed(key); throw new AppError('LOGIN_FAILED', 'That username or password is not correct.'); }
  loginOk(key);
  await db.query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
  res.cookie(COOKIE, makeToken({ uid: u.id }, config.loginHours), {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: config.loginHours * 3600_000, path: '/',
  });
  res.json({ user: { id: u.id, name: u.name, role: u.role }, cafeName: config.cafeName });
}));
router.post('/auth/logout', (_req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.status(204).end(); });
router.get('/auth/me', requireAuth, (req, res) => res.json({ user: { id: req.user!.id, name: req.user!.name, role: req.user!.role }, cafeName: config.cafeName }));

// ---------------------------------------------------------------- public (customer QR)
const pub = rateLimit('public', 240, 60_000);

const QR_FORMAT = /^[A-Za-z0-9_-]{16,64}$/;
async function tableByToken(token: string) {
  if (!QR_FORMAT.test(token)) throw new AppError('INVALID_QR_TOKEN', 'This QR code is not valid. Please ask the staff for help.');
  const t = (await db.query(`SELECT id, table_number, display_name FROM cafe_tables WHERE qr_token=$1 AND is_active`, [token])).rows[0];
  if (!t) throw new AppError('INVALID_QR_TOKEN', 'This QR code is not valid. Please ask the staff for help.');
  return t;
}

/** Customer access = signed token issued when the QR is scanned. Knowing a session id alone is not enough. */
function sessionAccess(req: Request): { sessionId: string; tableId: string } {
  const t = readToken<{ sid: string; tid: string }>((req.headers['x-session-token'] as string) ?? (req.query.token as string));
  if (!t || t.sid !== req.params.sessionId)
    throw new AppError('FORBIDDEN', 'Please scan the QR code on your table again to continue.');
  return { sessionId: t.sid, tableId: t.tid };
}

router.get('/public/menu', pub, wrap(async (req, res) => {
  const m = await menu.publicMenu();
  const etag = `"menu-${m.version}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) return void res.status(304).end();
  res.json(m);
}));

router.get('/public/tables/:qrToken', pub, wrap(async (req, res) => {
  const t = await tableByToken(req.params.qrToken);
  res.json({ cafeName: config.cafeName, table: { number: t.table_number, displayName: t.display_name }, orderingAvailable: true });
}));

router.post('/public/tables/:qrToken/session', pub, wrap(async (req, res) => {
  const t = await tableByToken(req.params.qrToken);
  const s = await withTx((c, emit) => orders.getOrCreateSession(c, emit, t.id, null));
  res.status(s.created ? 201 : 200).json({
    sessionId: s.id, sessionToken: makeToken({ sid: s.id, tid: t.id }, 12),
    cafeName: config.cafeName, table: { number: t.table_number, displayName: t.display_name },
  });
}));

async function openSessionOr409(sessionId: string) {
  const s = (await db.query(`SELECT s.id, s.status, t.table_number FROM table_sessions s JOIN cafe_tables t ON t.id=s.table_id WHERE s.id=$1`, [sessionId])).rows[0];
  if (!s) throw new AppError('SESSION_NOT_FOUND', 'We could not find this table session. Please scan the QR code again.');
  if (s.status !== 'OPEN') throw new AppError('SESSION_CLOSED', 'This table session is closed. Refresh the QR menu to continue.');
  return s;
}

router.get('/public/sessions/:sessionId', pub, wrap(async (req, res) => {
  const { sessionId } = sessionAccess(req);
  const s = await openSessionOr409(sessionId);
  const bill = (await db.query(`SELECT total FROM bills WHERE session_id=$1`, [sessionId])).rows[0];
  res.json({ session: { id: s.id, tableNumber: s.table_number }, orders: await orders.loadOrders(db, sessionId, true), confirmedTotal: bill?.total ?? '0.00' });
}));

router.get('/public/sessions/:sessionId/menu', pub, wrap(async (req, res) => {
  const { sessionId } = sessionAccess(req);
  await openSessionOr409(sessionId);
  res.setHeader('Cache-Control', 'no-cache');
  res.json(await menu.publicMenu());
}));

router.post('/public/sessions/:sessionId/orders', rateLimit('order', 30, 60_000), wrap(async (req, res) => {
  const { sessionId } = sessionAccess(req);
  const b = parse(orderBody, req.body);
  const r = await orders.createOrder({ sessionId, items: b.items, customerNote: b.customerNote, idempotencyKey: b.idempotencyKey, source: 'CUSTOMER_QR', requestId: req.id });
  const all = await orders.loadOrders(db, sessionId, true);
  res.status(r.duplicate ? 200 : 201).json({ order: all.find((o: any) => o.id === r.orderId), duplicate: r.duplicate });
}));

router.get('/public/events', pub, wrap(async (req, res) => {
  const t = readToken<{ sid: string }>(req.query.token as string);
  if (!t) throw new AppError('FORBIDDEN', 'Please scan the QR code on your table again to continue.');
  openStream(res);
  addClient({ kind: 'public', sessionId: t.sid, res });
}));

// ---------------------------------------------------------------- everything below needs sign-in
router.use(requireAuth);

router.get('/events', wrap(async (req, res) => {
  openStream(res);
  addClient({ kind: 'staff', role: role(req), res });
}));

// ---- tables & queues
router.get('/tables', wrap(async (req, res) => res.json({ tables: await orders.tableSummaries(role(req)) })));
router.get('/tables/:tableId', wrap(async (req, res) => {
  const d = await orders.tableSession(id(req, 'tableId'), role(req));
  res.json({ table: d.table, session: d.session });
}));
router.get('/tables/:tableId/session', wrap(async (req, res) => res.json(await orders.tableSession(id(req, 'tableId'), role(req)))));
router.post('/tables/:tableId/session', wrap(async (req, res) => {
  const sessionId = await orders.startSessionManually(actor(req), id(req, 'tableId'));
  res.status(201).json({ sessionId });
}));

async function sessionTable(sessionId: string) {
  const r = (await db.query(`SELECT table_id FROM table_sessions WHERE id=$1`, [sessionId])).rows[0];
  if (!r) throw new AppError('SESSION_NOT_FOUND', 'We could not find this table session.');
  return r.table_id as string;
}
router.get('/sessions/:sessionId', wrap(async (req, res) => {
  const sid = id(req, 'sessionId');
  const s = (await db.query(`SELECT id, table_id AS "tableId", session_number AS "sessionNumber", status, opened_at AS "openedAt", closed_at AS "closedAt" FROM table_sessions WHERE id=$1`, [sid])).rows[0];
  if (!s) throw new AppError('SESSION_NOT_FOUND', 'We could not find this table session.');
  res.json({ session: s, orders: await orders.loadOrders(db, sid, false), bill: await orders.billView(db, sid, role(req)) });
}));
router.get('/sessions/:sessionId/orders', wrap(async (req, res) => {
  const sid = id(req, 'sessionId'); await sessionTable(sid);
  res.json({ orders: await orders.loadOrders(db, sid, false) });
}));

router.post('/staff/sessions/:sessionId/orders', wrap(async (req, res) => {
  const b = parse(orderBody, req.body);
  const r = await orders.createOrder({ sessionId: id(req, 'sessionId'), items: b.items, customerNote: b.customerNote, idempotencyKey: b.idempotencyKey, source: 'STAFF', userId: req.user!.id, requestId: req.id });
  res.status(r.duplicate ? 200 : 201).json({ orderId: r.orderId, duplicate: r.duplicate });
}));

// ---- order & item actions
router.get('/orders/:orderId', wrap(async (req, res) => {
  const o = (await db.query(`SELECT session_id FROM orders WHERE id=$1`, [id(req, 'orderId')])).rows[0];
  if (!o) throw new AppError('NOT_FOUND', 'Order not found.');
  res.json({ order: (await orders.loadOrders(db, o.session_id, false)).find((x: any) => x.id === req.params.orderId) });
}));
const ok = (res: Response) => res.json({ ok: true });
router.post('/orders/:orderId/accept', requireManager, wrap(async (req, res) => { await orders.acceptOrder(actor(req), id(req, 'orderId')); ok(res); }));
router.post('/orders/:orderId/reject', requireManager, wrap(async (req, res) => { await orders.rejectOrder(actor(req), id(req, 'orderId'), parse(reasonBody, req.body).reason); ok(res); }));
router.post('/orders/:orderId/cancel', requireManager, wrap(async (req, res) => { await orders.cancelOrder(actor(req), id(req, 'orderId'), parse(reasonBody, req.body).reason); ok(res); }));
router.post('/orders/:orderId/served', wrap(async (req, res) => { await orders.serveOrder(actor(req), id(req, 'orderId')); ok(res); }));
router.post('/orders/:orderId/items/:itemId/accept', requireManager, wrap(async (req, res) => { await orders.acceptItem(actor(req), id(req, 'orderId'), id(req, 'itemId')); ok(res); }));
router.post('/orders/:orderId/items/:itemId/reject', requireManager, wrap(async (req, res) => { await orders.rejectItem(actor(req), id(req, 'orderId'), id(req, 'itemId'), parse(reasonBody, req.body).reason); ok(res); }));
router.post('/orders/:orderId/items/:itemId/cancel', requireManager, wrap(async (req, res) => { await orders.cancelItem(actor(req), id(req, 'orderId'), id(req, 'itemId'), parse(reasonBody, req.body).reason); ok(res); }));
router.post('/orders/:orderId/items/:itemId/served', wrap(async (req, res) => { await orders.serveItem(actor(req), id(req, 'orderId'), id(req, 'itemId')); ok(res); }));
router.patch('/orders/:orderId/items/:itemId', wrap(async (req, res) => {
  // Status can never be patched directly; only quantity and notes.
  const b = parse(z.object({ quantity: z.number().optional(), notes: z.string().max(300).nullish(), reason: z.string().max(300).optional() }).strict(), req.body);
  await orders.editItem(actor(req), id(req, 'orderId'), id(req, 'itemId'), b); ok(res);
}));

// ---- menu
router.get('/menu', wrap(async (_req, res) => res.json(await menu.fullMenu())));
const sectionBody = z.object({ name: z.string().trim().min(1, 'Please enter a name.').max(80), description: z.string().max(300).nullish() });
const priceStr = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,8}(\.\d{1,2})?$/.test(v), 'Price must be a number like 120 or 120.50.');
const itemBody = z.object({
  sectionId: uuid, name: z.string().trim().min(1, 'Please enter a name.').max(120), description: z.string().max(400).nullish(),
  foodType: z.enum(['VEG', 'NON_VEG', 'EGG']), price: priceStr, taxRate: z.number(), isAvailable: z.boolean().optional(), imageUrl: z.string().url().max(500).nullish(),
});
router.get('/menu/sections/:sectionId/items', wrap(async (req, res) => {
  const full = await menu.fullMenu();
  res.json({ items: full.sections.find((s: any) => s.id === req.params.sectionId)?.items ?? [] });
}));
router.post('/menu/sections', requireManager, wrap(async (req, res) => res.status(201).json({ id: await menu.createSection(actor(req), parse(sectionBody, req.body)) })));
router.patch('/menu/sections/:sectionId', requireManager, wrap(async (req, res) => {
  const b = parse(sectionBody.partial().extend({ sortOrder: z.number().int().optional(), isActive: z.boolean().optional() }).strict(), req.body);
  await menu.updateSection(actor(req), id(req, 'sectionId'), b); ok(res);
}));
router.post('/menu/sections/:sectionId/deactivate', requireManager, wrap(async (req, res) => { await menu.updateSection(actor(req), id(req, 'sectionId'), { isActive: false }); ok(res); }));
router.post('/menu/items', requireManager, wrap(async (req, res) => res.status(201).json({ id: await menu.createItem(actor(req), parse(itemBody, req.body)) })));
router.patch('/menu/items/:itemId', requireManager, wrap(async (req, res) => {
  const b = parse(itemBody.partial().extend({ sortOrder: z.number().int().optional(), isActive: z.boolean().optional() }).strict(), req.body);
  await menu.updateItem(actor(req), id(req, 'itemId'), b); ok(res);
}));
router.post('/menu/items/:itemId/deactivate', requireManager, wrap(async (req, res) => { await menu.updateItem(actor(req), id(req, 'itemId'), { isActive: false }); ok(res); }));
router.put('/menu/sort', requireManager, wrap(async (req, res) => { await menu.sortMenu(actor(req), parse(z.object({ type: z.enum(['sections', 'items']), ids: z.array(uuid).max(500) }), req.body)); ok(res); }));

// ---- billing (manager); staff only get totals inside the table view
router.get('/sessions/:sessionId/bill', requireManager, wrap(async (req, res) => res.json({ bill: await orders.billView(db, id(req, 'sessionId'), 'MANAGER') })));
router.post('/sessions/:sessionId/bill', requireManager, wrap(async (req, res) => res.json({ bill: await orders.billView(db, id(req, 'sessionId'), 'MANAGER') }))); // bills are created automatically with the session
router.post('/bills/:billId/payments', requireManager, wrap(async (req, res) => {
  const b = parse(z.object({
    method: z.enum(['CASH', 'UPI']), amount: z.union([z.string(), z.number()]).transform(String),
    referenceNumber: z.string().max(100).nullish(), notes: z.string().max(300).nullish(), idempotencyKey: z.string().min(8).max(100).optional(),
  }), req.body);
  const r = await billing.recordPayment(actor(req), id(req, 'billId'), b);
  res.status(r.duplicate ? 200 : 201).json(r);
}));
router.post('/payments/:paymentId/void', requireManager, wrap(async (req, res) => { await billing.voidPayment(actor(req), id(req, 'paymentId'), parse(reasonBody, req.body).reason); ok(res); }));
router.post('/bills/:billId/close', requireManager, wrap(async (req, res) => { await billing.closeBill(actor(req), id(req, 'billId')); ok(res); }));
const dateQ = (req: Request) => String(req.query.date ?? new Date().toLocaleDateString('en-CA', { timeZone: config.timezone }));
router.get('/reports/daily-payments', requireManager, wrap(async (req, res) => res.json(await billing.dailyPayments(dateQ(req)))));
router.get('/reports/daily-sales', requireManager, wrap(async (req, res) => res.json(await billing.dailySales(dateQ(req)))));

// ---- notifications
router.get('/notifications', wrap(async (req, res) => res.json({ notifications: await admin.listNotifications(req.user!.id, req.query.unread === 'true') })));
router.post('/notifications/read-all', wrap(async (req, res) => { await admin.markAllRead(req.user!.id); ok(res); }));
router.post('/notifications/:notificationId/read', wrap(async (req, res) => { await admin.markRead(req.user!.id, id(req, 'notificationId')); ok(res); }));

// ---- QR codes
router.get('/qr-codes', requireManager, wrap(async (_req, res) => res.json({ codes: await admin.allQrs() })));
router.get('/tables/:tableId/qr', requireManager, wrap(async (req, res) => res.json(await admin.tableQr(id(req, 'tableId')))));
router.post('/tables/:tableId/regenerate-qr', requireManager, wrap(async (req, res) => { await admin.regenerateQr(actor(req), id(req, 'tableId')); ok(res); }));

// ---- users & audit
router.get('/users', requireManager, wrap(async (_req, res) => res.json({ users: await admin.listUsers() })));
router.post('/users', requireManager, wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1, 'Please enter a name.').max(80), username: z.string().trim().min(3, 'Username needs at least 3 letters.').max(60), password: z.string().max(200), role: z.enum(['MANAGER', 'STAFF']).default('STAFF') }), req.body);
  res.status(201).json({ id: await admin.createUser(actor(req), b) });
}));
router.patch('/users/:userId', requireManager, wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), role: z.enum(['MANAGER', 'STAFF']).optional(), isActive: z.boolean().optional(), password: z.string().max(200).optional() }).strict(), req.body);
  await admin.updateUser(actor(req), id(req, 'userId'), b); ok(res);
}));
router.get('/audit-logs', requireManager, wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  res.json(await admin.listAudit(page, 30));
}));

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const msg = first?.message && !/^(Required|Expected|Invalid)/.test(first.message) ? first.message : 'Some of the information is missing or not valid. Please check and try again.';
    return void res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: msg, details: { fields: err.issues.map((i) => i.path.join('.')) } } });
  }
  if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The request could not be read.', details: {} } });
  console.error(`[${req.id}]`, err); // never log passwords or tokens
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.', details: { requestId: req.id } } });
}
