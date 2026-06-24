import { pino } from 'pino';

import { createAuthService } from './auth/auth-service';
import { createOAuthTokenStore } from './auth/oauth-token-store';
import { createDb } from './db/client';
import { loadDotenv } from './db/load-env';
import { createDeviceRegistry } from './registry/device-registry';
import { createSessionRegistry } from './registry/session-registry';
import { buildRelay } from './relay';

/** Dev/prod entry point for the relay (`pnpm --filter @telecode/relay start`). */
loadDotenv();
const log = pino({
  name: 'relay',
  level: process.env.LOG_LEVEL ?? 'info',
  // Defense in depth: never let a secret or plaintext payload reach a log sink.
  redact: {
    paths: [
      'token',
      '*.token',
      'payload',
      '*.payload',
      'text',
      'prompt',
      'channel_token',
      'device_token',
    ],
    censor: '[redacted]',
  },
});
const port = Number(process.env.RELAY_PORT ?? 8080);

const databaseUrl = process.env.DATABASE_URL;
const channelTokenSecret = process.env.CHANNEL_TOKEN_SECRET;
const serviceSecret = process.env.RELAY_SERVICE_SECRET;
const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;

const dbHandle = databaseUrl ? createDb(databaseUrl, log) : undefined;
const authEnabled = Boolean(dbHandle && channelTokenSecret && serviceSecret);
if (!dbHandle) {
  log.warn('relay: DATABASE_URL not set — session registry + auth disabled (echo-only mode)');
} else if (!channelTokenSecret || !serviceSecret) {
  log.warn('relay: CHANNEL_TOKEN_SECRET / RELAY_SERVICE_SECRET not set — auth endpoints disabled');
} else if (!tokenEncryptionKey) {
  log.warn('relay: TOKEN_ENCRYPTION_KEY not set — GitHub token storage + repo listing disabled');
}

const app = await buildRelay({
  logger: log,
  ...(dbHandle ? { sessionRegistry: createSessionRegistry(dbHandle) } : {}),
  ...(authEnabled && dbHandle && channelTokenSecret && serviceSecret
    ? {
        auth: {
          service: createAuthService({ db: dbHandle, channelTokenSecret }),
          serviceSecret,
        },
        deviceRegistry: createDeviceRegistry(dbHandle),
        ...(tokenEncryptionKey
          ? {
              oauthTokenStore: createOAuthTokenStore({
                db: dbHandle,
                encryptionKey: tokenEncryptionKey,
              }),
            }
          : {}),
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
