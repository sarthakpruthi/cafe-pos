// One-time setup: creates the tables + QR tokens, an optional sample menu, and the first manager login.
// Safe to run again; it only adds what is missing.
import readline from 'node:readline/promises';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { initDb, db, closeDb } from './db.js';
import { config } from './config.js';
import { newToken } from './services/admin.js';

await initDb({ url: config.databaseUrl, dataDir: config.dataDir });

const count = Number(process.env.TABLE_COUNT ?? 10);
for (let n = 1; n <= count; n++) {
  await db.query(`INSERT INTO cafe_tables (table_number, qr_token) VALUES ($1,$2) ON CONFLICT (table_number) DO NOTHING`, [String(n), newToken()]);
}
console.log(`Tables ready: ${count}`);

const hasMenu = Number((await db.query(`SELECT COUNT(*)::int AS n FROM menu_sections`)).rows[0].n) > 0;
if (!hasMenu && !process.argv.includes('--no-sample-menu')) {
  const sample: Array<[string, Array<[string, string, string, number]>]> = [
    ['Hot drinks', [['Masala chai', 'Ginger and cardamom tea', 'VEG', 30], ['Filter coffee', 'South Indian style', 'VEG', 40], ['Cappuccino', '', 'VEG', 120]]],
    ['Cold drinks', [['Cold coffee', 'With ice cream', 'VEG', 140], ['Fresh lime soda', 'Sweet or salted', 'VEG', 70]]],
    ['Snacks', [['Veg sandwich', 'Grilled, with cheese', 'VEG', 110], ['Chicken puff', '', 'NON_VEG', 80], ['Egg bhurji toast', '', 'EGG', 100], ['French fries', '', 'VEG', 90]]],
  ];
  let si = 1;
  for (const [name, items] of sample) {
    const s = (await db.query(`INSERT INTO menu_sections (name, sort_order) VALUES ($1,$2) RETURNING id`, [name, si++])).rows[0];
    let ii = 1;
    for (const [n, d, ft, p] of items)
      await db.query(`INSERT INTO menu_items (section_id,name,description,food_type,price,tax_rate,sort_order) VALUES ($1,$2,$3,$4,$5,5,$6)`, [s.id, n, d || null, ft, p, ii++]);
  }
  console.log('Sample menu added (you can change it from the Menu page).');
}

const hasManager = Number((await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='MANAGER'`)).rows[0].n) > 0;
if (!hasManager) {
  let username = process.env.MANAGER_USERNAME ?? '';
  let password = process.env.MANAGER_PASSWORD ?? '';
  let generated = false;
  if ((!username || !password) && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    username = (await rl.question('Choose a manager username [manager]: ')).trim() || 'manager';
    password = (await rl.question('Choose a manager password (at least 8 characters): ')).trim();
    rl.close();
  }
  if (!username) username = 'manager';
  if (!password) { password = randomBytes(9).toString('base64url'); generated = true; }
  if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  await db.query(`INSERT INTO users (name, username, password_hash, role) VALUES ('Manager', $1, $2, 'MANAGER')`, [username, await bcrypt.hash(password, 10)]);
  console.log(`Manager login created. Username: ${username}${generated ? `   Password: ${password}   (write it down now; it is shown only once)` : ''}`);
} else {
  console.log('A manager login already exists.');
}
await closeDb();
