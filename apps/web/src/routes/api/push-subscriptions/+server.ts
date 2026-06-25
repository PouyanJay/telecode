import { error } from '@sveltejs/kit';

import { deletePushSubscription, savePushSubscription } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { RequestHandler } from './$types';

/**
 * BFF for web push: the browser POSTs its `PushSubscription` here, the server forwards it to the relay
 * with the session-cookie token (the relay owns persistence — AD-1). The subscription never includes a
 * bearer the browser holds; auth is the first-party cookie.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
  const token = getSessionToken(cookies);
  if (!token) {
    error(401, 'Not signed in.');
  }
  const subscription = (await request.json()) as unknown;
  const ok = await savePushSubscription(token, subscription);
  if (!ok) {
    error(502, 'Could not register the subscription.');
  }
  return new Response(null, { status: 201 });
};

export const DELETE: RequestHandler = async ({ request, cookies }) => {
  const token = getSessionToken(cookies);
  if (!token) {
    error(401, 'Not signed in.');
  }
  const { endpoint } = (await request.json()) as { endpoint?: string };
  if (endpoint) {
    await deletePushSubscription(token, endpoint);
  }
  return new Response(null, { status: 204 });
};
