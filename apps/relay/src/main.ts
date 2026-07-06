import { pino } from 'pino';

import { createAuthService } from './auth/auth-service';
import { createOAuthTokenStore } from './auth/oauth-token-store';
import { createDb } from './db/client';
import { loadDotenv } from './db/load-env';
import { createWebPushSender } from './push/push-sender';
import { createPushSubscriptionStore } from './push/push-subscription-store';
import { createDeviceRegistry } from './registry/device-registry';
import { createSessionRegistry } from './registry/session-registry';
import { createAzureInfraScaler } from './infra/azure-infra-scaler';
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
      '*.device_token',
      'deviceToken',
      '*.deviceToken',
      'priorDeviceToken',
      '*.priorDeviceToken',
      'prior_device_token',
      '*.prior_device_token',
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
// Where pairing codes are entered — the daemon prints this in its "Go to … and enter <code>" prompt.
// Without APP_URL it falls back to the local dev app, which is wrong on a hosted relay.
const appUrl = process.env.APP_URL?.replace(/\/+$/, '');

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

// Defaults for the abuse-prevention caps (overridable by env). 64 KB covers the relay's tiny JSON bodies;
// 32 WS connections per IP accommodates a daemon plus several browser tabs sharing a NAT egress IP.
const DEFAULT_BODY_LIMIT_BYTES = 65_536;
const DEFAULT_MAX_WS_CONNECTIONS_PER_IP = 32;
const ENV_TRUE = ['1', 'true'];

function isValidPositiveInt(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

/** Read a positive-integer env var, warning and falling back to `fallback` when unset or malformed. */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!isValidPositiveInt(parsed)) {
    log.warn(
      { [name]: raw },
      `relay: ${name} is not a positive integer — using default ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

// HTTP rate limiting: ON by default so a public relay sheds abuse; tune with RATELIMIT_MAX / RATELIMIT_WINDOW
// (a humanized duration, e.g. '1 minute'), or set RATELIMIT_DISABLED=true to turn off. Behind a reverse
// proxy, TRUST_PROXY=true makes request.ip the real client so per-IP limiting is correct; RATELIMIT_ALLOWLIST
// exempts the web tier's egress (its traffic aggregates every user); REDIS_URL shares the budget across
// relay instances.
const rateLimitDisabled = ENV_TRUE.includes(process.env.RATELIMIT_DISABLED ?? '');
const rateLimitMaxRaw = process.env.RATELIMIT_MAX;
const rateLimitMax = rateLimitMaxRaw ? Number(rateLimitMaxRaw) : undefined;
if (rateLimitMaxRaw && !isValidPositiveInt(rateLimitMax)) {
  log.warn(
    { RATELIMIT_MAX: rateLimitMaxRaw },
    'relay: RATELIMIT_MAX is not a positive integer — using default',
  );
}
const trustProxy = ENV_TRUE.includes(process.env.TRUST_PROXY ?? '');
const rateLimitAllowList = (process.env.RATELIMIT_ALLOWLIST ?? '')
  .split(',')
  .map((ip) => ip.trim())
  .filter((ip) => ip.length > 0);
const rateLimit = rateLimitDisabled
  ? undefined
  : {
      ...(isValidPositiveInt(rateLimitMax) ? { max: rateLimitMax } : {}),
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

// Abuse prevention: a small body cap rejects oversized HTTP payloads with 413 before buffering, and a per-IP
// WebSocket cap bounds how many sockets one client can hold open. Both on by default with sane values.
const bodyLimit = parsePositiveIntEnv('BODY_LIMIT', DEFAULT_BODY_LIMIT_BYTES);
const maxConnectionsPerIp = parsePositiveIntEnv(
  'MAX_WS_CONNECTIONS_PER_IP',
  DEFAULT_MAX_WS_CONNECTIONS_PER_IP,
);

// Telemetry is OFF by default — telecode collects nothing. Opt in with TELECODE_TELEMETRY=on; events then
// go to THIS relay's own logs (no network/third-party sink exists in the codebase). See docs/telemetry.md.
const telemetryEnabled = [...ENV_TRUE, 'on'].includes(process.env.TELECODE_TELEMETRY ?? '');
const telemetry = createTelemetry({ enabled: telemetryEnabled, logger: log });
log.info({ telemetry_enabled: telemetryEnabled }, 'relay: telemetry configured');

// Operator-only infra controls (scale-to-zero toggles). Enabled only when an operator allowlist AND the
// full Azure config are present; otherwise the endpoints aren't registered and the web hides the panel.
const operatorEmails = (process.env.TELECODE_OPERATOR_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim())
  .filter((email) => email.length > 0);
const azureSubscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
const azureResourceGroup = process.env.AZURE_RESOURCE_GROUP;
const azureWebAppName = process.env.AZURE_WEB_APP_NAME;
const azureRelayAppName = process.env.AZURE_RELAY_APP_NAME;
const infraScaler =
  operatorEmails.length > 0 &&
  azureSubscriptionId &&
  azureResourceGroup &&
  azureWebAppName &&
  azureRelayAppName
    ? createAzureInfraScaler({
        subscriptionId: azureSubscriptionId,
        resourceGroup: azureResourceGroup,
        webAppName: azureWebAppName,
        relayAppName: azureRelayAppName,
        ...(process.env.AZURE_CLIENT_ID
          ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID }
          : {}),
      })
    : undefined;
log.info({ infra_controls_enabled: Boolean(infraScaler) }, 'relay: infra controls configured');

const app = await buildRelay({
  logger: log,
  ...(trustProxy ? { trustProxy } : {}),
  ...(appUrl ? { verificationUri: `${appUrl}/activate` } : {}),
  bodyLimit,
  maxConnectionsPerIp,
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
        ...(infraScaler ? { infra: { scaler: infraScaler, operatorEmails } } : {}),
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
