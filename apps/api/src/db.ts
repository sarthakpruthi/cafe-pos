import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { broadcast, type Audience } from './realtime.js';
import { config } from './config.js';

export interface Q { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>; }
export type Emit = (type: string, payload: Record<string, unknown>, audience: Audience) => void;

let pool: pg.Pool | null = null;
let lite: PGlite | null = null;

/**
 * Supabase (and most hosted Postgres) require TLS. Supabase signs with its own certificate
 * authority, which Node does not trust out of the box, so by default we encrypt without verifying
 * the certificate (what the Supabase docs do too). For full verification, download the project's CA
 * (Supabase → Project Settings → Database → SSL Configuration) and point DATABASE_SSL_CA at it, or
 * set DATABASE_SSL=verify to check against Node's built-in list.
 *
 * DATABASE_SSL / ?sslmode=  accept: disable | no-verify (default for remote) | verify-full.
 */
function sslFor(url: string): pg.PoolConfig['ssl'] {
  let host = '';
  let mode = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    mode = (u.searchParams.get('sslmode') ?? '').toLowerCase();
  } catch { /* not a standard URL — treat it as local */ }
  const setting = (process.env.DATABASE_SSL ?? mode).toLowerCase();
  if (setting === 'disable' || setting === 'off') return undefined;
  const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal && !setting) return undefined;
  // Strongest option: verify against the provider's own CA file.
  if (process.env.DATABASE_SSL_CA) return { ca: fs.readFileSync(process.env.DATABASE_SSL_CA, 'utf8'), rejectUnauthorized: true };
  if (setting === 'verify' || setting === 'verify-full' || setting === 'verify-ca') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export async function initDb(opts: { url?: string; dataDir?: string }) {
  if (opts.url) {
    pool = new pg.Pool({ connectionString: opts.url, max: 10, ssl: sslFor(opts.url) });
    await pool.query('SELECT 1');
  } else {
    const dir = opts.dataDir ?? './data/pgdata';
    if (!dir.startsWith('memory://')) fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
    lite = new PGlite(dir);
    await lite.waitReady;
  }
  await migrate();
  await ensureDefaultCafe();
}

/**
 * The single cafe that predates the `cafes` table. Its name and sign-in domain are kept in step
 * with the settings so staff created before cafes existed can still sign in.
 */
async function ensureDefaultCafe() {
  await db.query(
    `UPDATE cafes SET name = $1, email_domain = $2, updated_at = now() WHERE is_default`,
    [config.cafeName, config.supabase.staffEmailDomain]);
}

export const db: Q = {
  query: (sql, params) => {
    if (pool) return pool.query(sql, params) as any;
    return lite!.query(sql, params) as any;
  },
};

/** Run work in one transaction. Realtime events are sent only after COMMIT succeeds. */
export async function withTx<T>(fn: (c: Q, emit: Emit) => Promise<T>): Promise<T> {
  const queued: Array<() => void> = [];
  const emit: Emit = (type, payload, audience) =>
    queued.push(() => broadcast({ eventId: randomUUID(), type, occurredAt: new Date().toISOString(), payload }, audience));
  let result: T;
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      result = await fn(client as any, emit);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    result = await lite!.transaction(async (tx) => fn(tx as any, emit));
  }
  queued.forEach((f) => f());
  return result;
}

async function migrate() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    if (lite) {
      await lite.exec(sql);
    } else {
      const client = await pool!.connect();
      try { await client.query('BEGIN'); await client.query(sql); await client.query('COMMIT'); }
      catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}

export async function closeDb() {
  if (pool) await pool.end();
  if (lite) await lite.close();
}
