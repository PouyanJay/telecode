import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { type AuthService } from '../auth/auth-service';
import { requireUser } from '../auth/require-auth';
import { type DeviceRegistry } from './device-registry';
import { type SessionRegistry } from './session-registry';

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
  /** When provided, revoking a device also ends its non-terminal sessions (they can never reconcile once
   *  the device is gone). Optional so the auth-less/echo relay path stays unaffected. */
  sessionRegistry?: SessionRegistry,
  /** Called with the ids the revoke cascade ended, so the relay can tell watching browsers — a live
   *  dashboard must clear the revoked device's sessions without a refresh. */
  onSessionsEnded?: (input: { userId: string; deviceId: string; sessionIds: string[] }) => void,
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
    // A revoked device is gone for good — end its still-running/awaiting sessions so they don't linger as
    // phantom rows no daemon will ever reconcile (the per-connection reconcile only reaches a device that
    // reconnects). Best-effort: a failure here must not fail the revoke itself.
    let endedSessionIds: string[] = [];
    if (sessionRegistry) {
      try {
        endedSessionIds = await sessionRegistry.endSessionsForDevice({
          userId,
          deviceId: params.data.id,
        });
        if (endedSessionIds.length > 0) {
          onSessionsEnded?.({ userId, deviceId: params.data.id, sessionIds: endedSessionIds });
        }
      } catch (err) {
        request.log.warn(
          { err, userId, deviceId: params.data.id },
          'device revoke: could not end sessions',
        );
      }
    }
    request.log.info(
      { userId, deviceId: params.data.id, endedSessions: endedSessionIds.length },
      'device revoked',
    );
    return reply.code(204).send();
  });
}
