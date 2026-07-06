import { sessionRenameBodySchema } from '@telecode/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { type AuthService } from '../auth/auth-service';
import { requireUser } from '../auth/require-auth';
import { decodeSessionCursor, encodeSessionCursor } from './session-cursor';
import {
  type SessionMutationOutcome,
  type SessionRegistry,
  type SessionSummary,
} from './session-registry';

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
  /**
   * Called after a session row is permanently deleted (ux Phase 6 T7) so the relay can evict the
   * session's ciphertext replay cache — a deleted session's frames must never replay to a later
   * subscriber. Absent on the auth-less/echo relay path.
   */
  readonly onSessionDeleted?: (event: { userId: string; sessionId: string }) => void;
}

/** A session id path param. */
const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * Ended-page size bounds (T7): the default keeps a cold dashboard load light; the cap bounds the
 * worst-case rows a single request can pull regardless of what a client asks for.
 */
const MIN_ENDED_PAGE_SIZE = 1;
const DEFAULT_ENDED_PAGE_SIZE = 50;
const MAX_ENDED_PAGE_SIZE = 200;

/** `GET /me/sessions` query (T7): an ended-page size, an opaque cursor, and the archived-view flag. */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(MIN_ENDED_PAGE_SIZE).max(MAX_ENDED_PAGE_SIZE).optional(),
  // Cursors are short base64url JSON; the cap fails garbage fast with a clean 400.
  cursor: z.string().min(1).max(512).optional(),
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

/** `PATCH /me/sessions/:id/archive` body: shelve (true) or restore (false). */
const archiveBodySchema = z.object({ archived: z.boolean() });

/** One session row on the wire — the explicit snake_case mapping is the boundary. */
function wireSession(session: SessionSummary): Record<string, unknown> {
  return {
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
    archived_at: session.archivedAt?.toISOString() ?? null,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
    ended_at: session.endedAt?.toISOString() ?? null,
  };
}

/** Map a housekeeping outcome to its HTTP reply (`ok` → 204; still-going → 409; not yours → 404). */
function sendMutationOutcome(reply: FastifyReply, outcome: SessionMutationOutcome): FastifyReply {
  switch (outcome) {
    case 'ok':
      return reply.code(204).send();
    case 'not_ended':
      return reply.code(409).send({ error: 'session_not_ended' });
    case 'not_found':
      return reply.code(404).send({ error: 'session_not_found' });
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * Web → relay session endpoints, session-token authed (the same bearer the web reads from its httpOnly
 * cookie); the relay derives the user from the token, never from the client. RLS scopes every read/write
 * to the owner. Returns/accepts routing + opaque sealed metadata only — never plaintext the relay can't
 * see (invariant #5). The explicit snake_case mapping is the wire boundary.
 *   - `GET /me/sessions` — list the user's sessions for the dashboard + reconnect (T7: active in full,
 *     ended paginated behind an opaque cursor; `?archived=true` pages the archived view instead).
 *   - `PATCH /me/sessions/:id` — set or reset the user's sealed rename override.
 *   - `PATCH /me/sessions/:id/archive` — shelve/restore a terminal session (T7).
 *   - `DELETE /me/sessions/:id` — permanently delete a terminal session (T7).
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
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const scope = query.data.archived ? 'archived' : 'ended';
    const decoded = query.data.cursor !== undefined ? decodeSessionCursor(query.data.cursor) : null;
    // A cursor minted for the OTHER view fails closed rather than paginating from a skewed offset.
    if (query.data.cursor !== undefined && (decoded === null || decoded.scope !== scope)) {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }
    const page = await registry.listPage({
      userId,
      endedLimit: query.data.limit ?? DEFAULT_ENDED_PAGE_SIZE,
      ...(decoded ? { cursor: decoded.cursor } : {}),
      archived: query.data.archived,
    });
    return reply.send({
      sessions: page.sessions.map(wireSession),
      next_cursor: page.nextCursor ? encodeSessionCursor(page.nextCursor, scope) : null,
    });
  });

  app.patch('/me/sessions/:id/archive', async (request, reply) => {
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = archiveBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const outcome = await registry.setArchived({
      userId,
      sessionId: params.data.id,
      archived: body.data.archived,
    });
    request.log.info(
      { userId, sessionId: params.data.id, archived: body.data.archived, outcome },
      'session archive',
    );
    return sendMutationOutcome(reply, outcome);
  });

  app.delete('/me/sessions/:id', async (request, reply) => {
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const outcome = await registry.deleteSession({ userId, sessionId: params.data.id });
    if (outcome === 'ok') {
      // The row is gone — its cached ciphertext must never replay to a later subscriber.
      options.onSessionDeleted?.({ userId, sessionId: params.data.id });
    }
    request.log.info({ userId, sessionId: params.data.id, outcome }, 'session delete');
    return sendMutationOutcome(reply, outcome);
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
