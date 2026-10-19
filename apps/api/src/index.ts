import { createApp } from './app.js';
import { config } from './config.js';
import { initDb } from './drivers/node.js';
import { authMode } from './supabase.js';

await initDb({ url: config.databaseUrl, dataDir: config.dataDir });
createApp().listen(config.port, () => {
  console.log(`${config.cafeName} ordering system is running on http://localhost:${config.port}`);
  console.log(config.databaseUrl ? 'Database: PostgreSQL' : `Database: built-in local PostgreSQL (${config.dataDir})`);
  console.log(authMode() === 'supabase'
    ? 'Staff sign-in: Supabase Auth'
    : 'Staff sign-in: NOT CONFIGURED - set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env before anyone can sign in');
});
