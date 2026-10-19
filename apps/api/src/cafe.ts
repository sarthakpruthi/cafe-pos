// Create a new cafe (shop) and its first manager. Run after the initial setup: `npm run cafe`.
// Every cafe gets its own sign-in domain, so the same username can be used in different cafes.
import readline from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { initDb, db, closeDb } from './db.js';
import { config } from './config.js';
import { authMode, staffAuth } from './supabase.js';

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cafe';

await initDb({ url: config.databaseUrl, dataDir: config.dataDir });

if (authMode() === 'memory') {
  console.error('Staff sign-in runs on Supabase Auth, so SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env first.');
  process.exit(1);
}

const rd = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, def = '') => (await rd.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;

const name = process.env.NEW_CAFE_NAME?.trim() || await ask('Cafe name');
if (!name) { console.error('A cafe name is required.'); process.exit(1); }
const slug = slugify(name);
if ((await db.query('SELECT 1 FROM cafes WHERE slug = $1', [slug])).rows.length) {
  console.error(`A cafe named "${name}" (slug "${slug}") already exists.`);
  process.exit(1);
}

const username = process.env.NEW_CAFE_MANAGER_USERNAME?.trim() || await ask('Manager username (they type this to sign in)', 'manager');
let password = process.env.NEW_CAFE_MANAGER_PASSWORD?.trim() || '';
let generated = false;
if (!password) {
  password = await ask('Manager password (leave blank to generate one)');
  if (!password) { password = randomBytes(9).toString('base64url'); generated = true; }
}
rd.close();
if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }

// The cafe's own sign-in domain. The default cafe keeps the plain domain so existing logins work.
const emailDomain = `${slug}.${config.supabase.staffEmailDomain}`;

const cafeId = (await db.query<{ id: string }>(
  `INSERT INTO cafes (name, slug, email_domain) VALUES ($1,$2,$3) RETURNING id`, [name, slug, emailDomain])).rows[0].id;

let authId: string;
try {
  authId = await staffAuth.create({ username, name: 'Manager', password, role: 'MANAGER', emailDomain });
} catch (e: any) {
  await db.query('DELETE FROM cafes WHERE id = $1', [cafeId]); // do not leave a cafe with no manager
  console.error(`Could not create the manager login: ${e?.message ?? e}`);
  process.exit(1);
}
await db.query(`INSERT INTO users (id, name, username, role, cafe_id) VALUES ($1,'Manager',$2,'MANAGER',$3)`, [authId, username, cafeId]);

console.log(`\nCafe created: ${name}`);
console.log(`  Sign-in domain: ${emailDomain}   (staff sign in as ${username}@${emailDomain})`);
console.log(`  Manager login:  ${username}${generated ? `   Password: ${password}   (write it down now; it is shown only once)` : ''}`);
await closeDb();
