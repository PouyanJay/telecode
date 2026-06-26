import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { registerRateLimit } from '../src/rate-limit';

/**
 * The Redis store-selection seam (Phase 5 Task 2). A hosted relay can run as more than one instance behind
 * a load balancer, so the rate-limit budget must be shared in Redis rather than counted per-process. This
 * proves the wiring without a live Redis: the client factory is injected, so we can assert that a Redis
 * client is built and handed to the plugin only when `redisUrl` is configured, and that it is closed on
 * shutdown (an un-quit client would leak a connection per relay restart).
 */
interface RegisterCall {
  readonly options: { redis?: unknown; max?: number; allowList?: readonly string[] };
}

function fakeApp(): {
  instance: FastifyInstance;
  registrations: RegisterCall[];
  closeHooks: Array<() => unknown>;
} {
  const registrations: RegisterCall[] = [];
  const closeHooks: Array<() => unknown> = [];
  const instance = {
    async register(_plugin: unknown, options: RegisterCall['options']): Promise<void> {
      registrations.push({ options });
    },
    addHook(name: string, fn: () => unknown): void {
      if (name === 'onClose') closeHooks.push(fn);
    },
  } as unknown as FastifyInstance;
  return { instance, registrations, closeHooks };
}

describe('rate-limit Redis store selection', () => {
  it('builds a Redis client and passes it to the plugin when redisUrl is set', async () => {
    const quit = vi.fn().mockResolvedValue('OK');
    const client = { quit } as unknown as Redis;
    const createRedis = vi.fn().mockReturnValue(client);
    const { instance, registrations, closeHooks } = fakeApp();

    await registerRateLimit(instance, { redisUrl: 'redis://cache:6379', max: 100 }, createRedis);

    expect(createRedis).toHaveBeenCalledWith('redis://cache:6379');
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.options.redis).toBe(client);
    expect(registrations[0]?.options.max).toBe(100);

    // The client must be closed on shutdown so a restart loop doesn't leak Redis connections.
    expect(closeHooks).toHaveLength(1);
    await closeHooks[0]?.();
    expect(quit).toHaveBeenCalledOnce();
  });

  it('uses the in-memory store (no Redis client) when redisUrl is absent', async () => {
    const createRedis = vi.fn();
    const { instance, registrations, closeHooks } = fakeApp();

    await registerRateLimit(instance, { max: 50 }, createRedis);

    expect(createRedis).not.toHaveBeenCalled();
    expect(registrations[0]?.options.redis).toBeUndefined();
    expect(closeHooks).toHaveLength(0);
  });

  it('forwards the allowList of trusted IPs to the plugin', async () => {
    const { instance, registrations } = fakeApp();

    await registerRateLimit(instance, { allowList: ['203.0.113.10'] }, vi.fn());

    expect(registrations[0]?.options.allowList).toEqual(['203.0.113.10']);
  });
});
