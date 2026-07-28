import pg from 'pg';

const { Pool } = pg;

export function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not configured');
  return new Pool({ connectionString, max: 10 });
}

// Waits for the database to accept connections (Postgres may still be starting
// when the API container boots). Reliability requirement.
export async function waitForDb(pool, { retries = 30, delayMs = 1000 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
