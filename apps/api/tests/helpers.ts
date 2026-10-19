import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { initDb, db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { newToken } from '../src/services/admin.js';
import { signStaffToken, useMemoryAuth, type StaffRole } from '../src/supabase.js';

export async function boot() {
  // Never touch the network or a real Supabase project while testing.
  useMemoryAuth();
  await initDb({ dataDir: 'memory://' });
  for (let n = 1; n <= 10; n++) await db.query(`INSERT INTO cafe_tables (table_number, qr_token) VALUES ($1,$2)`, [String(n), newToken()]);
  const cafeId = (await db.query<{ id: string }>(`SELECT id FROM cafes WHERE is_default`)).rows[0].id;
  // Staff sign in through Supabase Auth; the profile row carries the same id. No password is stored
  // by the app any more, so the tests just insert the profile and mint tokens (see client.login).
  const people: Array<[string, string, StaffRole]> = [['Mia', 'manager', 'MANAGER'], ['Sam', 'staff', 'STAFF']];
  for (const [name, username, role] of people)
    await db.query(`INSERT INTO users (id, name, username, role, cafe_id) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), name, username, role, cafeId]);
  const sec = (await db.query(`INSERT INTO menu_sections (name) VALUES ('Drinks') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO menu_items (section_id,name,food_type,price,tax_rate) VALUES ($1,'Chai','VEG',30,5),($1,'Coffee','VEG',100,18),($1,'Sold out cake','VEG',50,5)`, [sec]);
  await db.query(`UPDATE menu_items SET is_available=false WHERE name='Sold out cake'`);
  const server = createApp().listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}/api/v1`;
  return { server, base };
}

export function client(base: string) {
  let token = '';
  let sessionToken = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionToken) headers['x-session-token'] = sessionToken;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b), put: (p: string, b: unknown) => call('PUT', p, b),
    /** Signs in the way the browser does: Supabase issues the token, and the API only verifies it. */
    login: async (username: string, cafeId?: string) => {
      const row = (await db.query(
        cafeId ? `SELECT id, role FROM users WHERE lower(username)=lower($1) AND cafe_id=$2`
               : `SELECT id, role FROM users WHERE lower(username)=lower($1)`,
        cafeId ? [username, cafeId] : [username])).rows[0];
      if (!row) return 401;
      token = await signStaffToken(row.id, row.role);
      return 200;
    },
    token: () => token,
    setSessionToken: (t: string) => { sessionToken = t; },
  };
}
