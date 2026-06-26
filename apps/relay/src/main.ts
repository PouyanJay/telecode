import { pino } from 'pino';

import { createAuthService } from './auth/auth-service';
import { createOAuthTokenStore } from './auth/oauth-token-store';
import { createDb } from './db/client';
import { loadDotenv } from './db/load-env';
import { createWebPushSender } from './push/push-sender';
import { createPushSubscriptionStore } from './push/push-subscription-store';
import { createDeviceRegistry } from './registry/device-registry';
import { createSessionRegistry } from './registry/session-registry';
import { buildRelay } from './relay';
import { createTelemetry } from './telemetry';

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
      'accessToken',
      '*.accessToken',
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
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:admin@telecode.local';

const dbHandle = databaseUrl ? createDb(databaseUrl, log) : undefined;
const authEnabled = Boolean(dbHandle && channelTokenSecret && serviceSecret);
const pushEnabled = Boolean(authEnabled && vapidPublicKey && vapidPrivateKey);
if (!dbHandle) {
  log.warn('relay: DATABASE_URL not set — session registry + auth disabled (echo-only mode)');
} else if (!channelTokenSecret || !serviceSecret) {
  log.warn('relay: CHANNEL_TOKEN_SECRET / RELAY_SERVICE_SECRET not set — auth endpoints disabled');
} else if (!tokenEncryptionKey) {
  log.warn('relay: TOKEN_ENCRYPTION_KEY not set — GitHub token storage + repo listing disabled');
}
if (authEnabled && !pushEnabled) {
  log.warn('relay: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push disabled');
}

// HTTP rate limiting (Phase 5): ON by default so a public relay sheds abuse; tune with RATELIMIT_MAX /
// RATELIMIT_WINDOW (a humanized duration, e.g. '1 minute'), or set RATELIMIT_DISABLED=true to turn off.
const rateLimitDisabled = ['1', 'true'].includes(process.env.RATELIMIT_DISABLED ?? '');
const rateLimitMaxRaw = process.env.RATELIMIT_MAX;
const rateLimitMax = rateLimitMaxRaw ? Number(rateLimitMaxRaw) : undefined;
if (rateLimitMax !== undefined && (!Number.isInteger(rateLimitMax) || rateLimitMax <= 0)) {
  log.warn(
    { RATELIMIT_MAX: rateLimitMaxRaw },
    'relay: RATELIMIT_MAX is not a positive integer — using default',
  );
}
// Behind a reverse proxy / load balancer (the hosted topology), TRUST_PROXY=true makes request.ip the
// real client so per-IP limiting is correct. RATELIMIT_ALLOWLIST exempts trusted IPs (the web tier's
// egress, whose traffic aggregates every user). REDIS_URL shares the budget across relay instances.
const trustProxy = ['1', 'true'].includes(process.env.TRUST_PROXY ?? '');
const rateLimitAllowList = (process.env.RATELIMIT_ALLOWLIST ?? '')
  .split(',')
  .map((ip) => ip.trim())
  .filter((ip) => ip.length > 0);
const rateLimit = rateLimitDisabled
  ? undefined
  : {
      ...(rateLimitMax !== undefined && Number.isInteger(rateLimitMax) && rateLimitMax > 0
        ? { max: rateLimitMax }
        : {}),
      ...(process.env.RATELIMIT_WINDOW ? { timeWindow: process.env.RATELIMIT_WINDOW } : {}),
      ...(process.env.REDIS_URL ? { redisUrl: process.env.REDIS_URL } : {}),
      ...(rateLimitAllowList.length > 0 ? { allowList: rateLimitAllowList } : {}),
    };
if (rateLimitDisabled) {
  log.warn('relay: RATELIMIT_DISABLED set — HTTP rate limiting is OFF');
}
if (rateLimit && !trustProxy) {
  log.warn(
    'relay: rate limiting is per-IP but TRUST_PROXY is off — behind a proxy set TRUST_PROXY=true so request.ip is the real client',
  );
}

// Abuse prevention (Phase 5): a small body cap rejects oversized HTTP payloads (bodies are all tiny JSON),
// and a per-IP WebSocket cap bounds how many sockets one client can hold open. Both tunable; both on by
// default with sane values.
const bodyLimit = process.env.BODY_LIMIT ? Number(process.env.BODY_LIMIT) : 65_536;
const maxWsPerIp = process.env.MAX_WS_CONNECTIONS_PER_IP
  ? Number(process.env.MAX_WS_CONNECTIONS_PER_IP)
  : 32;
const validBodyLimit = Number.isInteger(bodyLimit) && bodyLimit > 0 ? bodyLimit : 65_536;
const validMaxWsPerIp = Number.isInteger(maxWsPerIp) && maxWsPerIp > 0 ? maxWsPerIp : 32;

// Telemetry is OFF by default — telecode collects nothing. Opt in with TELECODE_TELEMETRY=on; events then
// go to THIS relay's own logs (no network/third-party sink exists in the codebase). See docs/telemetry.md.
const telemetryEnabled = ['1', 'true', 'on'].includes(process.env.TELECODE_TELEMETRY ?? '');
const telemetry = createTelemetry({ enabled: telemetryEnabled, logger: log });
log.info({ telemetry: telemetryEnabled }, 'relay: telemetry');

const app = await buildRelay({
  logger: log,
  ...(trustProxy ? { trustProxy } : {}),
  bodyLimit: validBodyLimit,
  maxConnectionsPerIp: validMaxWsPerIp,
  telemetry,
  ...(rateLimit ? { rateLimit } : {}),
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
        ...(pushEnabled && vapidPublicKey && vapidPrivateKey
          ? {
              push: {
                store: createPushSubscriptionStore(dbHandle),
                sender: createWebPushSender({
                  subject: vapidSubject,
                  publicKey: vapidPublicKey,
                  privateKey: vapidPrivateKey,
                }),
              },
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
