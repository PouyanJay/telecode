import { pino } from 'pino';

import { createAuthService } from './auth/auth-service';
import { createDb } from './db/client';
import { loadDotenv } from './db/load-env';
import { createDeviceRegistry } from './registry/device-registry';
import { createSessionRegistry } from './registry/session-registry';
import { buildRelay } from './relay';

/** Dev/prod entry point for the relay (`pnpm --filter @telecode/relay start`). */
loadDotenv();
const log = pino({ name: 'relay', level: process.env.LOG_LEVEL ?? 'info' });
const port = Number(process.env.RELAY_PORT ?? 8080);

const databaseUrl = process.env.DATABASE_URL;
const channelTokenSecret = process.env.CHANNEL_TOKEN_SECRET;
const serviceSecret = process.env.RELAY_SERVICE_SECRET;

const dbHandle = databaseUrl ? createDb(databaseUrl, log) : undefined;
if (!dbHandle) {
  log.warn('relay: DATABASE_URL not set — session registry + auth disabled (echo-only mode)');
} else if (!channelTokenSecret || !serviceSecret) {
  log.warn('relay: CHANNEL_TOKEN_SECRET / RELAY_SERVICE_SECRET not set — auth endpoints disabled');
}

const app = await buildRelay({
  logger: log,
  ...(dbHandle ? { sessionRegistry: createSessionRegistry(dbHandle) } : {}),
  ...(dbHandle && channelTokenSecret && serviceSecret
    ? {
        auth: {
          service: createAuthService({ db: dbHandle, channelTokenSecret }),
          serviceSecret,
        },
        deviceRegistry: createDeviceRegistry(dbHandle),
      }
    : {}),
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'relay: listening');
} catch (err) {
  log.error({ err }, 'relay: failed to listen');
  process.exit(1);
}
