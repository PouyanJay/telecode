import type { FastifyInstance } from 'fastify';

import { type AuthService } from '../auth/auth-service';
import { requireUser } from '../auth/require-auth';
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
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;
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
