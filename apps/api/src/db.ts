// The database entry point shared by every environment.
//
// The real connection is provided by a "driver":
//   * drivers/node.ts  — node-postgres (or built-in PGlite) for the CLI scripts, `npm run dev` and tests
//   * drivers/worker.ts — node-postgres over Cloudflare Hyperdrive for the deployed Worker
//
// Everything else (services, routes, auth) only ever talks to `db` and `withTx`, so the same code
// runs in both places.
import { randomUUID } from 'node:crypto';
import { broadcast, type Audience } from './realtime.js';

export interface Q { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>; }
export type Emit = (type: string, payload: Record<string, unknown>, audience: Audience) => void;

export interface Driver {
  /** Run a single statement. */
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  /** Run `fn` inside one transaction; its queries run on the same connection. */
  transaction<T>(fn: (c: Q) => Promise<T>): Promise<T>;
}

let driver: Driver | null = null;

/** Install the connection used by `db` and `withTx`. Called once at startup by each environment. */
export function useDriver(d: Driver) { driver = d; }
export function hasDriver() { return driver !== null; }

function current(): Driver {
  if (!driver) throw new Error('No database driver is installed yet.');
  return driver;
}

export const db: Q = {
  query: (sql, params) => current().query(sql, params),
};

/** Run work in one transaction. Realtime events are sent only after COMMIT succeeds. */
export async function withTx<T>(fn: (c: Q, emit: Emit) => Promise<T>): Promise<T> {
  const queued: Array<() => void | Promise<void>> = [];
  const emit: Emit = (type, payload, audience) =>
    queued.push(() => broadcast({ eventId: randomUUID(), type, occurredAt: new Date().toISOString(), payload }, audience));
  const result = await current().transaction((c) => fn(c, emit));
  for (const send of queued) await send();
  return result;
}
