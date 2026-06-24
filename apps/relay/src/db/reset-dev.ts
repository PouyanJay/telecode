import { Pool } from 'pg';
import { pino } from 'pino';

import { loadDotenv } from './load-env';
import { runMigrations } from './migrate';

/**
 * Dev-only: drop the relay's registries (+ Drizzle's tracking + the app role) and re-apply all
 * migrations from scratch. Guarded to refuse any non-local `DATABASE_URL` so it can never wipe a real
 * database. Run via `pnpm --filter relay db:reset`.
 */
loadDotenv();
const log = pino({ name: 'relay:db:reset', level: process.env.LOG_LEVEL ?? 'info' });
const url = process.env.DATABASE_URL;
if (!url) {
  log.error('DATABASE_URL is not set');
  process.exit(1);
}
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  log.error('db:reset refuses a non-local DATABASE_URL (safety guard)');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
pool.on('error', (err) => log.warn({ err }, 'db: idle pool client error during reset'));
try {
  // Drop the registries + Drizzle's tracking; the migration re-creates them. The `telecode_app`
  // role is left in place (its creation is idempotent — `IF NOT EXISTS`), avoiding cross-role
  // privilege issues when the relay connects as a non-superuser BYPASSRLS role.
  await pool.query('drop schema if exists drizzle cascade');
  await pool.query('drop table if exists public.sessions cascade');
  await pool.query('drop table if exists public.auth_sessions cascade');
  await pool.query('drop table if exists public.devices cascade');
  await pool.query('drop table if exists public.users cascade');
} finally {
  await pool.end();
}
await runMigrations(url, log);
log.info('db reset + migrations applied');
