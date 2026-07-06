import { error } from '@sveltejs/kit';

import { deleteSession } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';
import { isSessionId } from '$lib/server/session-id';

import type { RequestHandler } from './$types';

/**
 * Session delete BFF (ux Phase 6 T7): permanently removes a TERMINAL session (row + the relay's
 * ciphertext cache). Forwards to the relay with the httpOnly session token; a 409 means the session is
 * still going (the relay refuses).
 */
export const DELETE: RequestHandler = async ({ params, cookies }) => {
  const token = getSessionToken(cookies);
  if (!token) {
    error(401, 'Not signed in.');
  }
  if (!isSessionId(params.id)) {
    error(400, 'Invalid session id.');
  }
  const result = await deleteSession(token, params.id);
  if (result.notFound) {
    error(404, 'This session no longer exists.');
  }
  if (result.conflict) {
    error(409, 'Only ended sessions can be deleted.');
  }
  if (!result.ok) {
    error(502, 'Could not reach the relay. Please try again.');
  }
  return new Response(null, { status: 204 });
};
