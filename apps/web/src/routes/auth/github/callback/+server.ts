import { error, redirect } from '@sveltejs/kit';

import { getProvider } from '$lib/server/auth/providers';
import { createRelaySession } from '$lib/server/relay-api';
import { setSessionCookie } from '$lib/server/session-cookie';

import type { RequestHandler } from './$types';

/** GitHub OAuth callback: verify state, exchange the code for an identity, open a session. */
export const GET: RequestHandler = async ({ url, cookies }) => {
  const provider = getProvider('github');
  if (!provider) {
    error(404, 'GitHub sign-in is not enabled.');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = cookies.get('telecode_oauth_state');
  if (!code || !state || !storedState || state !== storedState) {
    error(400, 'Invalid OAuth callback. Please try signing in again.');
  }

  const identity = await provider.completeLogin({
    code,
    redirectUri: `${url.origin}/auth/github/callback`,
  });
  const session = await createRelaySession(identity);
  setSessionCookie(cookies, session.token, session.expiresAt);
  cookies.delete('telecode_oauth_state', { path: '/' });
  redirect(303, '/');
};
