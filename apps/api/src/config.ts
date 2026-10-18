import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load a .env file if one exists (repo root first, then the API folder). Values already present in
// the real environment always win, so a hosting platform stays in control. Node 20.12+ has loadEnvFile.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.resolve(here, '../../..', '.env'), path.resolve(here, '..', '.env')]) {
  try { process.loadEnvFile(file); } catch { /* no .env there — that is fine */ }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';
if (isProd && (!env.AUTH_SECRET || env.AUTH_SECRET.length < 24 || env.AUTH_SECRET.startsWith('replace-with'))) {
  throw new Error('AUTH_SECRET must be set to a long random value in production.');
}
export const config = {
  isProd,
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL && !env.DATABASE_URL.includes('...') ? env.DATABASE_URL : undefined,
  dataDir: env.DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/pgdata'),
  frontendUrl: (env.FRONTEND_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  apiBaseUrl: (env.API_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  authSecret: env.AUTH_SECRET ?? 'dev-only-secret-change-me-dev-only-secret',
  cafeName: env.CAFE_NAME ?? 'My Cafe',
  timezone: env.CAFE_TIMEZONE ?? 'Asia/Kolkata',
  maxTaxRate: Number(env.MAX_TAX_RATE ?? 28),
  loginHours: Number(env.LOGIN_HOURS ?? 12),
};
