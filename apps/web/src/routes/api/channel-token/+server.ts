import { error, json } from '@sveltejs/kit';

import { mintChannelToken } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { RequestHandler } from './$types';

/**
 * Mint a short-lived channel token for the browser to open its relay WS. Authorized by the httpOnly
 * session cookie; the long-lived session token never reaches the browser JS or the relay WS.
 */
export const GET: RequestHandler = async ({ cookies }) => {
  const token = getSessionToken(cookies);
  if (!token) {
    error(401, 'Not signed in.');
  }
  const channelToken = await mintChannelToken(token);
  if (!channelToken) {
    error(401, 'Session expired. Sign in again.');
  }
  return json({ channelToken });
};
