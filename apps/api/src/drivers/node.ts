// Node driver: plain PostgreSQL (pg) or the built-in PGlite when no DATABASE_URL is set.
// Used by the CLI scripts (setup/cafe/passwd/migrate), `npm run dev`, and the test suite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { config } from '../config.js';
import { useDriver, type Driver, type Q } from '../db.js';

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

const driver: Driver = {
  query: (sql, params) => (pool ? (pool.query(sql, params) as any) : (lite!.query(sql, params) as any)),
  async transaction(fn) {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as any as Q);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
    return lite!.transaction((tx) => fn(tx as any as Q));
  },
};

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
  useDriver(driver);
  await migrate();
  await ensureDefaultCafe();
}

/**
 * The single cafe that predates the `cafes` table. Its name and sign-in domain are kept in step
 * with the settings so staff created before cafes existed can still sign in.
 */
async function ensureDefaultCafe() {
  await driver.query(
    `UPDATE cafes SET name = $1, email_domain = $2, updated_at = now() WHERE is_default`,
    [config.cafeName, config.supabase.staffEmailDomain]);
}

async function migrate() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../database/migrations');
  await driver.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await driver.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
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
    await driver.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}

export async function closeDb() {
  if (pool) await pool.end();
  if (lite) await lite.close();
}
