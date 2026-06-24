import { pino } from 'pino';

import { loadDotenv } from './load-env';
import { runMigrations } from './migrate';

/** CLI entrypoint: apply pending migrations to `DATABASE_URL` (`pnpm --filter relay db:migrate`). */
loadDotenv();
const log = pino({ name: 'relay:db:migrate', level: process.env.LOG_LEVEL ?? 'info' });
const url = process.env.DATABASE_URL;
if (!url) {
  log.error('DATABASE_URL is not set');
  process.exit(1);
}
await runMigrations(url);
log.info('migrations applied');
