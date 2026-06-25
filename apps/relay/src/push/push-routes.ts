import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { type AuthService } from '../auth/auth-service';
import { bearerToken } from '../auth/bearer';
import { type PushSubscriptionStore } from './push-subscription-store';

/**
 * Web → relay: register / remove the browser's push subscription so the relay can notify the user when a
 * session needs input. Session-token authed (the relay derives the user from the bearer, never the
 * client). The body mirrors the browser's `PushSubscription.toJSON()` (`{ endpoint, keys: {p256dh, auth} }`).
 */
const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2000),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
const unsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2000) });

export function registerPushRoutes(
  app: FastifyInstance,
  auth: AuthService,
  store: PushSubscriptionStore,
): void {
  app.post('/me/push-subscriptions', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const userId = await auth.validateSession(token);
    if (!userId) return reply.code(401).send({ error: 'invalid_session' });

    const parsed = subscriptionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    await store.save({
      userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    });
    return reply.code(201).send({ ok: true });
  });

  app.delete('/me/push-subscriptions', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const userId = await auth.validateSession(token);
    if (!userId) return reply.code(401).send({ error: 'invalid_session' });

    const parsed = unsubscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    await store.deleteByEndpoint({ userId, endpoint: parsed.data.endpoint });
    return reply.code(204).send();
  });
}
