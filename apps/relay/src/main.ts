import { pino } from 'pino';

import { buildRelay } from './relay';

/** Dev/prod entry point for the relay (`pnpm --filter @telecode/relay start`). */
const log = pino({ name: 'relay', level: process.env.LOG_LEVEL ?? 'info' });
const port = Number(process.env.RELAY_PORT ?? 8080);

const app = await buildRelay({ logger: log });

try {
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'relay: listening');
} catch (err) {
  log.error({ err }, 'relay: failed to listen');
  process.exit(1);
}
