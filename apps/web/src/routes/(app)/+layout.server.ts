import { redirect } from '@sveltejs/kit';

import { listDevices, listRepos } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { LayoutServerLoad } from './$types';

/**
 * The authenticated app shell's shared data: the signed-in user, their paired devices, and their repos
 * for the launch drawer. Loaded once for every page under `(app)` (the sidebar, system bar, and launch
 * drawer all consume it), so individual pages no longer re-fetch devices/repos. Unauthenticated requests
 * are bounced to sign-in here, the single guard for the whole group.
 */
export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  if (!locals.user) {
    redirect(303, '/signin');
  }
  const token = getSessionToken(cookies);
  const [devices, repoList] = token
    ? await Promise.all([listDevices(token), listRepos(token)])
    : [[], { connected: false, repos: [] }];
  return {
    user: locals.user,
    devices,
    githubConnected: repoList.connected,
    repos: repoList.repos,
  };
};
