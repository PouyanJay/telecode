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
  const [deviceResult, repoList, sessionResult] = token
    ? await Promise.all([listDevices(token), listRepos(token), listSessions(token)])
    : [
        { ok: true, items: [] },
        { connected: false, repos: [] },
        { ok: true, items: [], nextCursor: null },
      ];
  return {
    user: locals.user,
    devices: deviceResult.items,
    githubConnected: repoList.connected,
    repos: repoList.repos,
    sessions: sessionResult.items,
    // Where the first ended page stopped (T7) — the dashboard's "Load more" resumes from here; null
    // when the list is complete (or against a pre-T7 relay, whose list is always complete).
    sessionsCursor: sessionResult.nextCursor,
    // Error ≠ empty: when the relay couldn't be read, pages must show an outage state — never the
    // "no devices paired" onboarding that makes a healthy fleet look deleted.
    registryError: !deviceResult.ok || !sessionResult.ok,
  };
};
