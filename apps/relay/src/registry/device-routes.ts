import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { type AuthService } from '../auth/auth-service';
import { requireUser } from '../auth/require-auth';
import { type DeviceRegistry } from './device-registry';

/**
 * Web → relay device endpoints, session-token authed (the same bearer the web reads from its httpOnly
 * cookie); the relay derives the user from the token, never from the client:
 *   - `GET /me/devices` — list the user's paired devices so the browser knows which `(user_id, device_id)`
 *     channel to watch.
 *   - `DELETE /me/devices/:id` — revoke a device (RLS-scoped to the owner, so one user can't touch another's).
 */
const idParamSchema = z.object({ id: z.string().uuid() });

export function registerDeviceRoutes(
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
        os: device.os,
        last_seen_at: device.lastSeenAt?.toISOString() ?? null,
        public_key: device.publicKey,
      })),
    });
  });

  app.delete('/me/devices/:id', async (request, reply) => {
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const revoked = await registry.revoke(userId, params.data.id);
    if (!revoked) {
      // A 404 here also covers a cross-user attempt (RLS-scoped); log it for the audit trail.
      request.log.warn(
        { userId, deviceId: params.data.id },
        'device revoke: not found or not owned',
      );
      return reply.code(404).send({ error: 'device_not_found' });
    }
    request.log.info({ userId, deviceId: params.data.id }, 'device revoked');
    return reply.code(204).send();
  });
}
