import type { FastifyInstance } from 'fastify';

import { type AuthService } from '../auth/auth-service';
import { requireUser } from '../auth/require-auth';
import { type SessionRegistry } from './session-registry';

/**
 * Web → relay: list the authenticated user's sessions so the dashboard can render them and reconnect
 * can re-attach. Session-token authed (the same bearer the web reads from its httpOnly cookie); the
 * relay derives the user from the token, never from the client. Returns routing metadata only — never
 * the opaque launch payload, which the relay cannot read (and is encrypted in Phase 3). The explicit
 * snake_case mapping is the wire boundary: the internal `SessionSummary` domain type never leaks raw.
 */
export function registerSessionListRoute(
  app: FastifyInstance,
  auth: AuthService,
  registry: SessionRegistry,
): void {
  app.get('/me/sessions', async (request, reply) => {
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;
    const sessions = await registry.listByUser(userId);
    return reply.send({
      sessions: sessions.map((session) => ({
        id: session.id,
        device_id: session.deviceId,
        title: session.title,
        status: session.status,
        origin: session.origin,
        created_at: session.createdAt.toISOString(),
        updated_at: session.updatedAt.toISOString(),
        ended_at: session.endedAt?.toISOString() ?? null,
      })),
    });
  });
}
