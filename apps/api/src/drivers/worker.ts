// Workers driver: node-postgres talking to Postgres through Cloudflare Hyperdrive.
//
// Hyperdrive keeps the real connection pool, so the documented pattern is one short-lived Client
// per request. AsyncLocalStorage carries that Client down to `db.query`/`withTx`, which keeps every
// service and route unaware that the connection is per-request.
//
// Migrations do not run here: a Worker has no filesystem. Apply them out-of-band with
// `npm run migrate` (see the deployment guide) before or after deploying.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import pg from 'pg';
import { useDriver, type Driver, type Q } from '../db.js';

const clients = new AsyncLocalStorage<pg.Client>();

function client(): pg.Client {
  const c = clients.getStore();
  if (!c) throw new Error('A database query ran outside a request. Use hyperdriveMiddleware() first.');
  return c;
}

const driver: Driver = {
  query: (sql, params) => client().query(sql, params) as any,
  async transaction(fn) {
    const c = client();
    await c.query('BEGIN');
    try {
      const result = await fn(c as any as Q);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
  },
};

/**
 * Express middleware that opens a Client for the request, runs the rest of the request inside it,
 * and closes the Client when the response finishes.
 */
export function hyperdriveMiddleware(connectionString: string): RequestHandler {
  useDriver(driver);
  return (_req, res, next) => {
    const c = new pg.Client({ connectionString });
    c.connect()
      .then(() => {
        let done = false;
        const close = () => { if (!done) { done = true; void c.end().catch(() => {}); } };
        res.on('close', close);
        res.on('finish', close);
        clients.run(c, () => next());
      })
      .catch(next);
  };
}

/** Run one statement on a throwaway connection (used outside a request, e.g. while authorizing SSE). */
export async function withPg<T>(env: { HYPERDRIVE: { connectionString: string } }, fn: (c: Q) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  await c.connect();
  try {
    return await fn(c as any as Q);
  } finally {
    await c.end().catch(() => {});
  }
}
