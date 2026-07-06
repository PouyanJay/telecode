import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
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

/** What the revoke cascade ended — one named shape shared by the registry, the route, and the relay. */
export interface SessionsEndedEvent {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionIds: readonly string[];
}

/** The revoke's optional side effects — absent on the auth-less/echo relay path. */
export interface DeviceRouteOptions {
  /** When provided, revoking a device also ends its non-terminal sessions (they can never reconcile once
   *  the device is gone). It also supplies the per-device history counts for the revoked listing. */
  readonly sessionRegistry?: SessionRegistry;
  /** Called with the ids the revoke cascade ended, so the relay can tell watching browsers — a live
   *  dashboard must clear the revoked device's sessions without a refresh. */
  readonly onSessionsEnded?: (event: SessionsEndedEvent) => void;
  /** Devices with a live verified restore request — the "awaiting re-authorization" flag per row. */
  readonly pendingRestoreDeviceIds?: () => readonly string[];
  /**
   * Whether a device's daemon is on its relay channel right now (the in-memory presence truth).
   * Feeds the `online` snapshot in `GET /me/devices`, so a cold page load renders honest presence
   * before its WebSocket lands (ux Phase 5). Absent → every device reports offline.
   */
  readonly isDeviceOnline?: (userId: string, deviceId: string) => boolean;
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  registry: DeviceRegistry,
  options: DeviceRouteOptions = {},
): void {
  /**
   * End the revoked device's still-running/awaiting sessions so they don't linger as phantom rows no
   * daemon will ever reconcile (the per-connection reconcile only reaches a device that reconnects),
   * and tell watching browsers. Best-effort: a failure here must not fail the revoke itself.
   */
  async function endRevokedDeviceSessions(
    userId: string,
    deviceId: string,
    log: FastifyBaseLogger,
  ): Promise<number> {
    if (!options.sessionRegistry) return 0;
    try {
      const sessionIds = await options.sessionRegistry.endSessionsForDevice({ userId, deviceId });
      if (sessionIds.length > 0) {
        options.onSessionsEnded?.({ userId, deviceId, sessionIds });
      }
      return sessionIds.length;
    } catch (err) {
      log.warn({ err, userId, deviceId }, 'device revoke: could not end sessions');
      return 0;
    }
  }

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
        // Live presence snapshot (ux Phase 5): whether this device's daemon is on its channel NOW.
        online: options.isDeviceOnline?.(userId, device.id) ?? false,
      })),
    });
  });

  app.get('/me/devices/revoked', async (request, reply) => {
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;
    const [revoked, sessionCounts] = await Promise.all([
      registry.findRevokedByUser(userId),
      options.sessionRegistry?.countByDevice(userId) ?? new Map<string, number>(),
    ]);
    const pendingRestore = new Set(options.pendingRestoreDeviceIds?.() ?? []);
    return reply.send({
      devices: revoked.map((device) => ({
        id: device.id,
        name: device.name,
        os: device.os,
        revoked_at: device.revokedAt.toISOString(),
        session_count: sessionCounts.get(device.id) ?? 0,
        pending_reauth: pendingRestore.has(device.id),
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
    const endedSessions = await endRevokedDeviceSessions(userId, params.data.id, request.log);
    request.log.info({ userId, deviceId: params.data.id, endedSessions }, 'device revoked');
    return reply.code(204).send();
  });
}
