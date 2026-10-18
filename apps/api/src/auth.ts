import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { AppError } from './errors.js';

export interface AuthUser { id: string; name: string; role: 'MANAGER' | 'STAFF'; username: string; }
declare global { namespace Express { interface Request { user?: AuthUser; id?: string; } } }

const b64 = (s: string) => Buffer.from(s).toString('base64url');
function sign(data: string) { return createHmac('sha256', config.authSecret).update(data).digest('base64url'); }

export function makeToken(payload: Record<string, unknown>, hours: number) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + hours * 3600_000 }));
  return `${body}.${sign(body)}`;
}
export function readToken<T = Record<string, any>>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

export const COOKIE = 'cafe_auth';

/** Loads the signed-in user (re-checked in the database every request, so deactivation is immediate). */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const t = readToken<{ uid: string }>(req.cookies?.[COOKIE]);
    if (t) {
      const r = await db.query<AuthUser & { is_active: boolean }>(
        'SELECT id, name, username, role, is_active FROM users WHERE id = $1', [t.uid]);
      if (r.rows[0]?.is_active) req.user = r.rows[0];
    }
    next();
  } catch (e) { next(e); }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError('UNAUTHENTICATED', 'Please sign in to continue.'));
  next();
}
export function requireManager(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError('UNAUTHENTICATED', 'Please sign in to continue.'));
  if (req.user.role !== 'MANAGER') return next(new AppError('FORBIDDEN', 'Only the manager can do this.'));
  next();
}

/** CSRF defence for cookie auth: SameSite=Lax cookie plus an Origin check on every write. */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && ![config.frontendUrl, config.apiBaseUrl].includes(origin)) {
    return next(new AppError('FORBIDDEN', 'This request came from an unknown website.'));
  }
  next();
}

// ---- Simple in-memory rate limiting (per process; fine for one cafe) ----
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(name: string, max: number, windowMs: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return next(); }
    if (++h.n > max) return next(new AppError('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.'));
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();

// ---- Login throttling: 5 wrong passwords locks that username+device for 10 minutes ----
const fails = new Map<string, { n: number; until: number }>();
export function loginLocked(key: string) { const f = fails.get(key); return !!f && f.until > Date.now(); }
export function loginFailed(key: string) {
  const f = fails.get(key) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 10 * 60_000; f.n = 0; }
  fails.set(key, f);
}
export function loginOk(key: string) { fails.delete(key); }
