import type { Handle } from '@sveltejs/kit';

import { getRelayUser } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

/** Resolve the signed-in user from the session cookie on every request (via the relay). */
export const handle: Handle = async ({ event, resolve }) => {
  const token = getSessionToken(event.cookies);
  event.locals.user = token ? await getRelayUser(token) : null;
  return resolve(event);
};
