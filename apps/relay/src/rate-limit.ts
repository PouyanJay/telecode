import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

/**
 * Rate-limit configuration for the relay (Phase 5). The relay is telecode's only publicly reachable
 * surface, so a hosted instance must shed abusive traffic before it reaches auth or the database. This is
 * a DI'd option on `buildRelay`: when absent the limiter is OFF (the echo path and the test suite stay
 * untouched), and `main.ts` turns it ON from the environment for production.
 *
 * The store is in-memory by default (correct for a single relay instance and for local dev/tests). A
 * Redis-backed store — shared across horizontally-scaled relay instances — is layered on in a later task.
 */
export interface RateLimitConfig {
  /** Max requests per window, per caller key (the client IP). Default 300. */
  readonly max?: number;
  /** Window length — milliseconds (number) or a humanized string like `'1 minute'`. Default `'1 minute'`. */
  readonly timeWindow?: number | string;
}

/** Register `@fastify/rate-limit` globally so every HTTP route inherits the window budget. */
export async function registerRateLimit(
  app: FastifyInstance,
  config: RateLimitConfig,
): Promise<void> {
  await app.register(rateLimit, {
    max: config.max ?? 300,
    timeWindow: config.timeWindow ?? '1 minute',
  });
}
