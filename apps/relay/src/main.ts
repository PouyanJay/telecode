import { pino } from 'pino';

import { createDb } from './db/client';
import { loadDotenv } from './db/load-env';
import { createSessionRegistry } from './registry/session-registry';
import { buildRelay } from './relay';

/** Dev/prod entry point for the relay (`pnpm --filter @telecode/relay start`). */
loadDotenv();
const log = pino({ name: 'relay', level: process.env.LOG_LEVEL ?? 'info' });
const port = Number(process.env.RELAY_PORT ?? 8080);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log.warn('relay: DATABASE_URL not set — session registry disabled (echo-only mode)');
}
const app = await buildRelay({
  logger: log,
  ...(databaseUrl ? { sessionRegistry: createSessionRegistry(createDb(databaseUrl, log)) } : {}),
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'relay: listening');
} catch (err) {
  log.error({ err }, 'relay: failed to listen');
  process.exit(1);
}
