import { createPool, waitForDb } from './db.js';
import { runMigrations } from './migrate.js';

async function main() {
  const pool = createPool();
  await waitForDb(pool);
  await runMigrations(pool);
  await pool.end();
  // eslint-disable-next-line no-console
  console.log('[migrate] done');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] failed:', err);
  process.exit(1);
});
