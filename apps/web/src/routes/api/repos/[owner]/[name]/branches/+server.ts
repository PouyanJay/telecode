import { error, json } from '@sveltejs/kit';

import { listRepoBranches } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { RequestHandler } from './$types';

/**
 * Branches of one GitHub repo for the launch drawer's base picker (Phase B). Authorized by the
 * httpOnly session cookie; the relay talks to GitHub with the user's stored token server-side.
 */
export const GET: RequestHandler = async ({ cookies, params }) => {
  const token = getSessionToken(cookies);
  if (!token) {
    error(401, 'Not signed in.');
  }
  return json(await listRepoBranches(token, params.owner, params.name));
};
