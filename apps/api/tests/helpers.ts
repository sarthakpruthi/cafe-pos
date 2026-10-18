import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { initDb, db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { newToken } from '../src/services/admin.js';

export async function boot() {
  await initDb({ dataDir: 'memory://' });
  for (let n = 1; n <= 10; n++) await db.query(`INSERT INTO cafe_tables (table_number, qr_token) VALUES ($1,$2)`, [String(n), newToken()]);
  const hash = await bcrypt.hash('password123', 4);
  await db.query(`INSERT INTO users (name, username, password_hash, role) VALUES ('Mia','manager',$1,'MANAGER'),('Sam','staff',$1,'STAFF')`, [hash]);
  const sec = (await db.query(`INSERT INTO menu_sections (name) VALUES ('Drinks') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO menu_items (section_id,name,food_type,price,tax_rate) VALUES ($1,'Chai','VEG',30,5),($1,'Coffee','VEG',100,18),($1,'Sold out cake','VEG',50,5)`, [sec]);
  await db.query(`UPDATE menu_items SET is_available=false WHERE name='Sold out cake'`);
  const server = createApp().listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}/api/v1`;
  return { server, base };
}

export function client(base: string) {
  let cookie = '';
  let sessionToken = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (sessionToken) headers['x-session-token'] = sessionToken;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b), put: (p: string, b: unknown) => call('PUT', p, b),
    login: async (u: string) => (await call('POST', '/auth/login', { username: u, password: 'password123' })).status,
    cookie: () => cookie,
    setSessionToken: (t: string) => { sessionToken = t; },
  };
}
