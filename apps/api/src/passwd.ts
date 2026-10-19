// Reset a staff member's sign-in password: `npm run passwd`.
// The password lives in Supabase Auth (not in our database), so this goes through the service role
// key. Handy when a manager or staff password is lost — there is no "forgot password" email.
import readline from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { initDb, db, closeDb } from './db.js';
import { config } from './config.js';
import { authMode, staffAuth } from './supabase.js';

await initDb({ url: config.databaseUrl, dataDir: config.dataDir });

if (authMode() === 'memory') {
  console.error('Staff sign-in runs on Supabase Auth, so SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env first.');
  process.exit(1);
}

const rd = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, def = '') => (await rd.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;

const username = (process.env.RESET_USERNAME ?? '').trim() || await ask('Username');
if (!username) { console.error('A username is required.'); process.exit(1); }

// Usernames repeat across cafes, so we may need to ask which one.
const matches = (await db.query<{ id: string; username: string; cafeName: string; isDefault: boolean }>(
  `SELECT u.id, u.username, c.name AS "cafeName", c.is_default AS "isDefault"
     FROM users u JOIN cafes c ON c.id = u.cafe_id
    WHERE u.username = $1
    ORDER BY c.is_default DESC, c.name`, [username])).rows;

if (!matches.length) {
  console.error(`No staff login called "${username}". Check the spelling (usernames are lower-cased).`);
  process.exit(1);
}

let chosen = matches[0];
if (matches.length > 1) {
  console.log(`"${username}" exists in more than one cafe:`);
  matches.forEach((m, i) => console.log(`  ${i + 1}) ${m.cafeName}${m.isDefault ? '  (original cafe)' : ''}`));
  const pick = await ask('Which cafe? (number)', '1');
  chosen = matches[Number(pick) - 1] ?? matches[0];
}

let password = (process.env.RESET_PASSWORD ?? '').trim();
let generated = false;
if (!password) {
  password = await ask('New password (leave blank to generate one)');
  if (!password) { password = randomBytes(9).toString('base64url'); generated = true; }
}
rd.close();
if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }

try {
  await staffAuth.setPassword(chosen.id, password);
} catch (e: any) {
  console.error(`Could not reset the password: ${e?.message ?? e}`);
  process.exit(1);
}

console.log(`\nPassword updated for "${chosen.username}" at ${chosen.cafeName}.`);
if (generated) console.log(`  New password: ${password}   (shown only once — write it down now)`);
console.log('Sign in with the username and this password (pick the right cafe on the sign-in screen).');
await closeDb();
