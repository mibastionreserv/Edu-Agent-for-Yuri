import { createApp } from './app.js';
import { createPool, waitForDb } from './db.js';
import { runMigrations } from './migrate.js';

const PORT = Number(process.env.PORT || 4000);

async function main() {
  const pool = createPool();
  await waitForDb(pool);
  await runMigrations(pool);

  const app = createApp(pool);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on :${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[api] failed to start:', err);
  process.exit(1);
});
