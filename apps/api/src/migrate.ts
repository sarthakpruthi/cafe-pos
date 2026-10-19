// Apply pending migrations (and sync the default cafe) against DATABASE_URL, then exit.
// A Worker has no filesystem, so this is how the schema is created/updated for the Cloudflare
// deployment. Safe to run repeatedly.
import { config } from './config.js';
import { initDb, closeDb } from './drivers/node.js';

await initDb({ url: config.databaseUrl, dataDir: config.dataDir });
console.log(`Migrations applied to ${config.databaseUrl ? 'PostgreSQL' : `the local database (${config.dataDir})`}.`);
await closeDb();
