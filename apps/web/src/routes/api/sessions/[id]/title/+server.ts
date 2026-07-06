import { sessionRenameBodySchema } from '@telecode/protocol';
import { error } from '@sveltejs/kit';

import { renameSession } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { RequestHandler } from './$types';

/** A session id is a uuid; validated at this trust boundary (the relay re-validates authoritatively). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session rename BFF (ux Phase 6 T6). The browser seals the new title under the session content key (the
 * server never sees plaintext) and PATCHes the sealed blob here; this forwards it to the relay with the
 * httpOnly session token, which the browser JS never holds. A reset-to-derived sends `{ sealed_title: null }`.
 */
export const PATCH: RequestHandler = async ({ params, request, cookies }) => {
  const token = getSessionToken(cookies);
  if (!token) {
    error(401, 'Not signed in.');
  }
  if (!UUID_RE.test(params.id)) {
    error(400, 'Invalid session id.');
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = sessionRenameBodySchema.safeParse(body);
  if (!parsed.success) {
    error(400, 'Invalid rename.');
  }
  const result = await renameSession(token, params.id, parsed.data);
  if (result.notFound) {
    error(404, 'This session no longer exists.');
  }
  if (!result.ok) {
    error(502, 'Could not reach the relay. Please try again.');
  }
  return new Response(null, { status: 204 });
};
