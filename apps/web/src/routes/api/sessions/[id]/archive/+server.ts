import { z } from 'zod';
import { error } from '@sveltejs/kit';

import { setSessionArchived } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';
import { isSessionId } from '$lib/server/session-id';

import type { RequestHandler } from './$types';

const bodySchema = z.object({ archived: z.boolean() });

/**
 * Archive/unarchive BFF (ux Phase 6 T7): shelves or restores a TERMINAL session. Forwards to the relay
 * with the httpOnly session token; a 409 means the session is still going (the relay refuses).
 */
export const PATCH: RequestHandler = async ({ params, request, cookies }) => {
  const token = getSessionToken(cookies);
  if (!token) {
    error(401, 'Not signed in.');
  }
  if (!isSessionId(params.id)) {
    error(400, 'Invalid session id.');
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    error(400, 'Invalid request.');
  }
  const result = await setSessionArchived(token, params.id, parsed.data.archived);
  if (result.notFound) {
    error(404, 'This session no longer exists.');
  }
  if (result.conflict) {
    error(409, 'Only ended sessions can be archived.');
  }
  if (!result.ok) {
    error(502, 'Could not reach the relay. Please try again.');
  }
  return new Response(null, { status: 204 });
};
