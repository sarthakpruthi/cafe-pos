import { createApp } from './app.js';
import { config } from './config.js';
import { initDb } from './db.js';

await initDb({ url: config.databaseUrl, dataDir: config.dataDir });
createApp().listen(config.port, () => {
  console.log(`${config.cafeName} ordering system is running on http://localhost:${config.port}`);
  console.log(config.databaseUrl ? 'Database: PostgreSQL' : `Database: built-in local PostgreSQL (${config.dataDir})`);
});
