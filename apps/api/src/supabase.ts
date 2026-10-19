// Supabase Auth integration.
//
// Staff sign in through Supabase Auth from the browser and send the resulting access token as a
// bearer token. This module does two jobs:
//   1. verify those tokens locally (signature + audience + expiry), and
//   2. manage accounts with the service role key (create a person, reset a password, switch a
//      login off) for the "Staff logins" page and the setup script.
//
// The service role key never leaves the server.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from './config.js';
import { AppError } from './errors.js';

export type StaffRole = 'MANAGER' | 'STAFF';

/**
 * Staff type a username; Supabase Auth needs an email, so we derive one from the cafe's own
 * sign-in domain. Two cafes can therefore both have a "manager".
 */
export const staffEmail = (username: string, emailDomain: string) => `${username.trim().toLowerCase()}@${emailDomain}`;

export interface StaffAuth {
  /** The Supabase user id when the token is valid, otherwise null. */
  verify(token: string): Promise<{ id: string; role: StaffRole | null } | null>;
  create(d: { username: string; name: string; password: string; role: StaffRole; emailDomain: string }): Promise<string>;
  setPassword(id: string, password: string): Promise<void>;
  setRole(id: string, role: StaffRole): Promise<void>;
  setBanned(id: string, banned: boolean): Promise<void>;
  remove(id: string): Promise<void>;
}

// ---------------------------------------------------------------- token verification

// Only used when no Supabase project is configured (the test suite). Never reached in production,
// because config refuses to start without SUPABASE_URL there.
const DEV_JWT_SECRET = 'dev-only-jwt-secret-not-for-production';

const secretKey = () => new TextEncoder().encode(config.supabase.jwtSecret || DEV_JWT_SECRET);
let jwks: JWTVerifyGetKey | null = null;

// The test suite swaps in the in-memory stand-in (see useMemoryAuth) so it never touches the
// network or a real project.
let memory = !config.supabase.url;
export function useMemoryAuth() { memory = true; }
export const authMode = (): 'supabase' | 'memory' => (memory ? 'memory' : 'supabase');

function keyFor(): Uint8Array | JWTVerifyGetKey {
  if (memory || config.supabase.jwtSecret) return secretKey();
  jwks ??= createRemoteJWKSet(new URL(`${config.supabase.url}/auth/v1/.well-known/jwks.json`));
  return jwks;
}

async function verifyToken(token: string): Promise<{ id: string; role: StaffRole | null } | null> {
  try {
    const { payload } = await jwtVerify(token, keyFor(), { audience: 'authenticated' });
    if (!payload.sub) return null;
    const claim = (payload as any).app_metadata?.role;
    return { id: String(payload.sub), role: claim === 'MANAGER' || claim === 'STAFF' ? claim : null };
  } catch {
    return null; // expired, tampered with, or not one of our tokens
  }
}

// ---------------------------------------------------------------- implementations

function supabaseAuth(): StaffAuth {
  const admin = createClient(config.supabase.url!, config.supabase.serviceRoleKey ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const fail = (e: { message?: string }): never => {
    throw new AppError('AUTH_SERVICE', `The sign-in service could not do that. ${e?.message ?? ''}`.trim());
  };
  return {
    verify: verifyToken,
    async create(d) {
      const { data, error } = await admin.auth.admin.createUser({
        email: staffEmail(d.username, d.emailDomain), password: d.password, email_confirm: true,
        user_metadata: { name: d.name }, app_metadata: { role: d.role },
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) throw new AppError('VALIDATION_ERROR', 'That username is already taken.');
        return fail(error);
      }
      return data.user.id;
    },
    async setPassword(id, password) { const { error } = await admin.auth.admin.updateUserById(id, { password }); if (error) fail(error); },
    async setRole(id, role) { const { error } = await admin.auth.admin.updateUserById(id, { app_metadata: { role } }); if (error) fail(error); },
    async setBanned(id, banned) { const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: banned ? '876000h' : 'none' }); if (error) fail(error); },
    async remove(id) { await admin.auth.admin.deleteUser(id).catch(() => {}); },
  };
}

/** In-memory stand-in used by the tests (no network). Tokens are still verified for real. */
function memoryAuth(): StaffAuth {
  return {
    verify: verifyToken,
    create: async () => randomUUID(),
    setPassword: async () => {},
    setRole: async () => {},
    setBanned: async () => {},
    remove: async () => {},
  };
}

// Built once so bad configuration is caught here rather than mid-request. createClient rejects an
// empty key, so a missing service role key simply leaves the admin side unavailable.
const real: StaffAuth | null = config.supabase.url && config.supabase.serviceRoleKey ? supabaseAuth() : null;
const fake = memoryAuth();
const pick = (): StaffAuth => {
  if (memory) return fake;
  if (!real) throw new AppError('AUTH_SERVICE', 'SUPABASE_SERVICE_ROLE_KEY is not set, so staff logins cannot be managed.');
  return real;
};

// Tokens are always verified for real; only the account-management calls swap out.
export const staffAuth: StaffAuth = {
  verify: (token) => verifyToken(token),
  create: (d) => pick().create(d),
  setPassword: (id, password) => pick().setPassword(id, password),
  setRole: (id, role) => pick().setRole(id, role),
  setBanned: (id, banned) => pick().setBanned(id, banned),
  remove: (id) => pick().remove(id),
};

/** Test helper: mints an access token exactly the way Supabase would. */
export async function signStaffToken(userId: string, role: StaffRole, seconds = 3600) {
  return new SignJWT({ role, app_metadata: { role } })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
    .sign(secretKey());
}
