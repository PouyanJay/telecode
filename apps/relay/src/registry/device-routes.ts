import type { FastifyInstance } from 'fastify';

import { bearerToken } from '../auth/bearer';
import { type AuthService } from '../auth/auth-service';
import { type DeviceRegistry } from './device-registry';

/**
 * Web → relay: list the authenticated user's paired devices so the browser knows which
 * `(user_id, device_id)` channel to watch. Session-token authed (the same bearer the web reads from its
 * httpOnly cookie); the relay derives the user from the token, never from the client.
 */
export function registerDeviceListRoute(
  app: FastifyInstance,
  auth: AuthService,
  registry: DeviceRegistry,
): void {
  app.get('/me/devices', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const userId = await auth.validateSession(token);
    if (!userId) {
      return reply.code(401).send({ error: 'invalid_session' });
    }
    const devices = await registry.findActiveByUser(userId);
    return reply.send({
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        last_seen_at: device.lastSeenAt?.toISOString() ?? null,
      })),
    });
  });
}
