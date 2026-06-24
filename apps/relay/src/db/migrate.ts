import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { type Logger } from 'pino';

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Apply all pending migrations in `src/db/migrations` to `connectionString`. Runs the same way against
 * the Supabase local stack (dev) and a plain Postgres container (CI) — it depends only on a Postgres URL,
 * not on the Supabase CLI's migration apply. Each migration (structural DDL + its hand-authored RLS block)
 * runs in a transaction; drizzle tracks applied migrations in `__drizzle_migrations`.
 */
export async function runMigrations(connectionString: string, logger?: Logger): Promise<void> {
  const pool = new Pool({ connectionString });
  pool.on('error', (err) => logger?.warn({ err }, 'db: idle pool client error during migrate'));
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
