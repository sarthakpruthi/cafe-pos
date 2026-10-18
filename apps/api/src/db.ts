import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { broadcast, type Audience } from './realtime.js';

export interface Q { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>; }
export type Emit = (type: string, payload: Record<string, unknown>, audience: Audience) => void;

let pool: pg.Pool | null = null;
let lite: PGlite | null = null;

/**
 * Supabase (and most hosted Postgres) require TLS; a local server usually does not.
 * Set `sslmode=disable` in the URL or `DATABASE_SSL=disable` to force it off,
 * and `sslmode=no-verify` / `DATABASE_SSL=no-verify` to skip certificate checks.
 */
function sslFor(url: string): pg.PoolConfig['ssl'] {
  let host = '';
  let mode = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    mode = (u.searchParams.get('sslmode') ?? '').toLowerCase();
  } catch { /* not a standard URL — treat it as local */ }
  const off = mode === 'disable' || process.env.DATABASE_SSL === 'disable';
  if (off) return undefined;
  const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal && !mode) return undefined;
  const noVerify = mode === 'no-verify' || process.env.DATABASE_SSL === 'no-verify';
  return { rejectUnauthorized: !noVerify };
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
