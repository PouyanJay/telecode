import rateLimit, { type RateLimitOptions, type RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';

/**
 * Rate-limit configuration for the relay. The relay is telecode's only publicly reachable surface, so a
 * hosted instance must shed abusive traffic before it reaches auth or the database. This is a DI'd option
 * on `buildRelay`: when absent the limiter is OFF (the echo path and the test suite stay untouched), and
 * `main.ts` turns it ON from the environment for production.
 *
 * The budget is keyed by client IP — which is only meaningful when `buildRelay({ trustProxy })` makes
 * `request.ip` the real client behind a reverse proxy. The store is in-memory by default (correct for a
 * single relay instance and for local dev/tests); set `redisUrl` to share the budget across horizontally
 * scaled relay instances.
 */
export interface RateLimitConfig {
  /** Max requests per window, per caller key (the client IP). Default {@link DEFAULT_RATE_LIMIT_MAX}. */
  readonly max?: number;
  /** Window length — milliseconds (number) or a humanized string like `'1 minute'`. */
  readonly timeWindow?: number | string;
  /** When set, share the budget across relay instances via a Redis store (else in-memory, per process). */
  readonly redisUrl?: string;
  /** IPs never limited — e.g. the trusted web tier whose egress aggregates every user's requests. */
  readonly allowList?: readonly string[];
}

/** Default global budget: requests per window, per IP. Generous — abuse-prone routes set tighter caps. */
export const DEFAULT_RATE_LIMIT_MAX = 300;
/** Default window for every budget (global and per-route). */
export const DEFAULT_RATE_LIMIT_WINDOW = '1 minute';

/** Builds the Redis client backing a shared rate-limit store. Injected in tests so no live Redis is needed. */
export type RedisClientFactory = (url: string) => Redis;

// Fail fast on a Redis hiccup rather than hanging request handling — paired with `skipOnError` below the
// limiter then fails open (a brief Redis outage degrades to "no limiting", never to a relay outage).
const REDIS_CONNECT_TIMEOUT_MS = 500;
const REDIS_MAX_RETRIES_PER_REQUEST = 1;

const defaultCreateRedis: RedisClientFactory = (url) =>
  new Redis(url, {
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: false,
  });

/**
 * Tight per-route budget for `/device/code` — the most abusable public endpoint (each call allocates an
 * in-memory pending-pairing record). Applied via the route's `config.rateLimit`; ignored when the limiter
 * is off. A real laptop pairs a handful of times, never dozens per minute.
 */
export const PAIRING_CODE_RATE_LIMIT = {
  max: 10,
  timeWindow: DEFAULT_RATE_LIMIT_WINDOW,
} satisfies RateLimitOptions;

/**
 * Per-route budget for `/device/token` — the daemon polls this roughly once a second while awaiting
 * approval, so the cap allows steady polling but still bounds a flood.
 */
export const PAIRING_POLL_RATE_LIMIT = {
  max: 90,
  timeWindow: DEFAULT_RATE_LIMIT_WINDOW,
} satisfies RateLimitOptions;

/**
 * Register `@fastify/rate-limit` globally so every HTTP route inherits the window budget (routes may
 * override it via `config.rateLimit`). The Redis client (when configured) is closed on relay shutdown.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  config: RateLimitConfig,
  createRedis: RedisClientFactory = defaultCreateRedis,
): Promise<void> {
  const options: RateLimitPluginOptions = {
    max: config.max ?? DEFAULT_RATE_LIMIT_MAX,
    timeWindow: config.timeWindow ?? DEFAULT_RATE_LIMIT_WINDOW,
    // Fail open if the (Redis) store errors: a store outage must never take the relay down.
    skipOnError: true,
    ...(config.allowList ? { allowList: [...config.allowList] } : {}),
  };
  if (config.redisUrl !== undefined) {
    const redis = createRedis(config.redisUrl);
    options.redis = redis;
    app.addHook('onClose', async () => {
      await redis.quit();
    });
  }
  await app.register(rateLimit, options);
}
