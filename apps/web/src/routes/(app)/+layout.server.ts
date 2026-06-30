import { redirect } from '@sveltejs/kit';

import { listDevices, listRepos, listSessions } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { LayoutServerLoad } from './$types';

/**
 * The authenticated app shell's shared data: the signed-in user, their paired devices, their repos for
 * the launch drawer, and the persisted session registry. Loaded once for every page under `(app)` — the
 * sidebar (session/device counts), system bar, launch drawer, and dashboard all consume it, so pages no
 * longer re-fetch. Unauthenticated requests are bounced to sign-in here, the single guard for the group.
 */
export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  if (!locals.user) {
    redirect(303, '/signin');
  }
  const token = getSessionToken(cookies);
  const [devices, repoList, sessions] = token
    ? await Promise.all([listDevices(token), listRepos(token), listSessions(token)])
    : [[], { connected: false, repos: [] }, []];
  return {
    user: locals.user,
    devices,
    githubConnected: repoList.connected,
    repos: repoList.repos,
    sessions,
  };
};
