import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { AppError } from './errors.js';
import { staffAuth } from './supabase.js';

export interface AuthUser { id: string; name: string; role: 'MANAGER' | 'STAFF'; username: string; cafeId: string; }
declare global { namespace Express { interface Request { user?: AuthUser; id?: string; } } }

const b64 = (s: string) => Buffer.from(s).toString('base64url');
function sign(data: string) { return createHmac('sha256', config.authSecret).update(data).digest('base64url'); }

/** Constant-time comparison for shared secrets (the public setup key). */
export function secretsMatch(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Signed tokens for *customers*: a QR scan issues one that is bound to a table session. Staff
 * sign-in is handled by Supabase Auth (see ./supabase.ts) and uses JWTs instead.
 */
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

/**
 * Reads the Supabase access token, verifies it, then loads the matching profile row. The profile is
 * re-read on every request so switching a login off takes effect immediately, before the token
 * would have expired.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    // Live updates use EventSource, which cannot set headers, so the token may arrive as ?token=.
    const token = bearer || (typeof req.query.token === 'string' ? req.query.token : undefined);
    if (token) {
      const claims = await staffAuth.verify(token);
      if (claims) {
        const r = await db.query<AuthUser & { is_active: boolean }>(
          'SELECT id, name, username, role, is_active, cafe_id AS "cafeId" FROM users WHERE id = $1', [claims.id]);
        if (r.rows[0]?.is_active) req.user = r.rows[0];
      }
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

/**
 * Defence in depth for writes: tokens travel in a header (not a cookie) so cross-site requests
 * cannot borrow a session, but we still reject writes that announce an unknown Origin.
 */
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
