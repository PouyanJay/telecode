import { sessionRenameBodySchema } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { type AuthService } from '../auth/auth-service';
import { requireUser } from '../auth/require-auth';
import { type SessionRegistry } from './session-registry';

/**
 * A session rename the relay must broadcast to the user's browsers (ux Phase 6 T6). The sealed blob is
 * `null`/`null` for a reset-to-derived; otherwise it's the opaque ciphertext the browser sent — the relay
 * relays it verbatim, never reading it (invariant #5).
 */
export interface SessionRenamedEvent {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly sealedTitle: string | null;
  readonly sealedTitleNonce: string | null;
}

export interface SessionRouteOptions {
  /**
   * Called after a successful rename so the relay can broadcast a `session.title` frame on the session's
   * device channel — a live dashboard updates the title across tabs without a refresh. Absent on the
   * auth-less/echo relay path.
   */
  readonly onSessionRenamed?: (event: SessionRenamedEvent) => void;
}

/** A session id path param. */
const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * Web → relay session endpoints, session-token authed (the same bearer the web reads from its httpOnly
 * cookie); the relay derives the user from the token, never from the client. RLS scopes every read/write
 * to the owner. Returns/accepts routing + opaque sealed metadata only — never plaintext the relay can't
 * see (invariant #5). The explicit snake_case mapping is the wire boundary.
 *   - `GET /me/sessions` — list the user's sessions for the dashboard + reconnect.
 *   - `PATCH /me/sessions/:id` — set or reset the user's sealed rename override.
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  registry: SessionRegistry,
  options: SessionRouteOptions = {},
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
        parent_session_id: session.parentSessionId,
        sealed_meta: session.sealedMeta,
        sealed_meta_nonce: session.sealedMetaNonce,
        sealed_title: session.sealedTitle,
        sealed_title_nonce: session.sealedTitleNonce,
        created_at: session.createdAt.toISOString(),
        updated_at: session.updatedAt.toISOString(),
        ended_at: session.endedAt?.toISOString() ?? null,
      })),
    });
  });

  app.patch('/me/sessions/:id', async (request, reply) => {
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = sessionRenameBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

    // A reset clears both columns; a set carries the browser-sealed blob. The ternary keys off the direct
    // `=== null` check (not the `isReset` alias) so its else branch narrows the union to the SET member,
    // making `sealed_title_nonce` present.
    const isReset = body.data.sealed_title === null;
    const patch =
      body.data.sealed_title === null
        ? { sealedTitle: null, sealedTitleNonce: null }
        : { sealedTitle: body.data.sealed_title, sealedTitleNonce: body.data.sealed_title_nonce };
    const result = await registry.setSealedTitle({
      userId,
      sessionId: params.data.id,
      ...patch,
    });
    if (!result) {
      // A 404 here also covers a cross-user attempt (RLS-scoped); log it for the audit trail (id only,
      // never the ciphertext).
      request.log.warn(
        { userId, sessionId: params.data.id },
        'session rename: not found or not owned',
      );
      return reply.code(404).send({ error: 'session_not_found' });
    }
    options.onSessionRenamed?.({
      userId,
      deviceId: result.deviceId,
      sessionId: params.data.id,
      ...patch,
    });
    request.log.info({ userId, sessionId: params.data.id, reset: isReset }, 'session renamed');
    return reply.code(204).send();
  });
}
