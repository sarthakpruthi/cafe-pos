import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The folder this file lives in. The Workers bundle has no `import.meta.url` (and no filesystem),
 * so fall back to the working directory there — the paths derived from it are only used by the CLI
 * scripts and local development.
 */
function moduleDir(): string {
  try { return path.dirname(fileURLToPath(import.meta.url)); }
  catch { return process.cwd(); }
}

// Load a .env file if one exists (repo root first, then the API folder). Values already present in
// the real environment always win, so a hosting platform stays in control. Node 20.12+ has loadEnvFile.
const here = moduleDir();
for (const file of [path.resolve(here, '../../..', '.env'), path.resolve(here, '..', '.env')]) {
  try { process.loadEnvFile(file); } catch { /* no .env there — that is fine */ }
}

const env = process.env;
/** A blank value in .env means "not set" — an empty AUTH_SECRET must not become an empty key. */
const str = (v: string | undefined) => (v && v.trim() ? v : undefined);

const isProd = env.NODE_ENV === 'production';
// On Cloudflare Workers the database connection comes from the Hyperdrive binding, not from
// DATABASE_URL, and the built-in PGlite driver is never installed (see worker/index.ts).
const onWorkers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
const authSecret = str(env.AUTH_SECRET);
if (isProd && (!authSecret || authSecret.length < 24 || authSecret.startsWith('replace-with'))) {
  throw new Error('AUTH_SECRET must be set to a long random value in production.');
}
// Staff sign-in runs on Supabase Auth, so production needs the project URL and the service role key
// (the key is only ever used on the server, to create staff logins and reset passwords).
const supabaseUrl = str(env.SUPABASE_URL)?.replace(/\/$/, '');
const serviceRoleKey = str(env.SUPABASE_SERVICE_ROLE_KEY);
if (isProd && !supabaseUrl) throw new Error('SUPABASE_URL must be set in production: staff sign-in uses Supabase Auth.');
if (isProd && !serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set in production.');
const databaseUrl = str(env.DATABASE_URL);
// Without a real database the app falls back to the built-in PGlite, whose data lives only for the
// life of the process — fine locally, silent data loss on any hosting platform. Workers are exempt:
// Hyperdrive always supplies a real connection there.
if (isProd && !onWorkers && !(databaseUrl && !databaseUrl.includes('...'))) {
  throw new Error('DATABASE_URL must be set in production: the built-in local database does not persist.');
}

export const config = {
  isProd,
  port: Number(str(env.PORT) ?? 4000),
  databaseUrl: databaseUrl && !databaseUrl.includes('...') ? databaseUrl : undefined,
  dataDir: str(env.DATA_DIR) ?? path.resolve(here, '../../../data/pgdata'),
  frontendUrl: (str(env.FRONTEND_URL) ?? 'http://localhost:4000').replace(/\/$/, ''),
  apiBaseUrl: (str(env.API_BASE_URL) ?? 'http://localhost:4000').replace(/\/$/, ''),
  authSecret: authSecret ?? 'dev-only-secret-change-me-dev-only-secret',
  adminSetupKey: str(env.ADMIN_SETUP_KEY),
  cafeName: str(env.CAFE_NAME) ?? 'My Cafe',
  timezone: str(env.CAFE_TIMEZONE) ?? 'Asia/Kolkata',
  maxTaxRate: Number(str(env.MAX_TAX_RATE) ?? 28),
  supabase: {
    url: supabaseUrl,
    serviceRoleKey,
    // Legacy Supabase projects sign tokens with a shared secret; newer ones publish a JWKS instead.
    jwtSecret: str(env.SUPABASE_JWT_SECRET),
    // Staff type a username but Supabase Auth needs an email, so we derive one from this domain.
    staffEmailDomain: str(env.STAFF_EMAIL_DOMAIN) ?? 'cafe.local',
  },
};
