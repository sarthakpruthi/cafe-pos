// One-time setup: creates the tables + QR tokens, an optional sample menu, and the first manager login.
// Safe to run again; it only adds what is missing.
import readline from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { initDb, db, closeDb } from './db.js';
import { config } from './config.js';
import { newToken } from './services/admin.js';
import { authMode, staffAuth } from './supabase.js';

await initDb({ url: config.databaseUrl, dataDir: config.dataDir });

// Everything below belongs to the original (default) cafe, whose name and sign-in domain come from
// CAFE_NAME / STAFF_EMAIL_DOMAIN. Extra cafes are created later with `npm run cafe`.
const cafe = (await db.query<{ id: string; emailDomain: string }>(
  `SELECT id, email_domain AS "emailDomain" FROM cafes WHERE is_default`)).rows[0];

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

const hasManager = Number((await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='MANAGER' AND cafe_id=$1`, [cafe.id])).rows[0].n) > 0;
if (!hasManager) {
  if (authMode() === 'memory') {
    console.error('Staff sign-in runs on Supabase Auth, so SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env before setup.');
    process.exit(1);
  }
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
  let authId: string;
  try {
    authId = await staffAuth.create({ username, name: 'Manager', password, role: 'MANAGER', emailDomain: cafe.emailDomain });
  } catch (e: any) {
    console.error(`Could not create the manager login: ${e?.message ?? e}`);
    console.error(`If Supabase already has "${username}", delete it there (Authentication → Users) or pick another username, then run setup again.`);
    process.exit(1);
  }
  await db.query(`INSERT INTO users (id, name, username, role, cafe_id) VALUES ($1,'Manager',$2,'MANAGER',$3)`, [authId, username, cafe.id]);
  console.log(`Manager login created. Username: ${username}${generated ? `   Password: ${password}   (write it down now; it is shown only once)` : ''}`);
} else {
  console.log('A manager login already exists.');
}
await closeDb();
