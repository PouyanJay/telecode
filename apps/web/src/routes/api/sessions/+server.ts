import { error, json } from '@sveltejs/kit';

import { listSessions } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { RequestHandler } from './$types';

/**
 * Session-page BFF (ux Phase 6 T7): "Load more" fetches the next ended (or archived) page here; this
 * forwards to the relay with the httpOnly session token the browser JS never holds. A cursor is
 * required — the first page always arrives via the server load, so a cursor-less call is a bug.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
  const token = getSessionToken(cookies);
  if (!token) {
    error(401, 'Not signed in.');
  }
  const cursor = url.searchParams.get('cursor');
  if (!cursor) {
    error(400, 'Missing cursor.');
  }
  const archived = url.searchParams.get('archived') === 'true';
  const page = await listSessions(token, { cursor, archived });
  if (!page.ok) {
    error(502, 'Could not reach the relay. Please try again.');
  }
  return json({
    sessions: page.items.map((session) => ({
      id: session.id,
      deviceId: session.deviceId,
      title: session.title,
      status: session.status,
      origin: session.origin,
      parentSessionId: session.parentSessionId,
      sealedMeta: session.sealedMeta,
      sealedMetaNonce: session.sealedMetaNonce,
      sealedTitle: session.sealedTitle,
      sealedTitleNonce: session.sealedTitleNonce,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      archivedAt: session.archivedAt?.toISOString() ?? null,
    })),
    nextCursor: page.nextCursor,
  });
};
