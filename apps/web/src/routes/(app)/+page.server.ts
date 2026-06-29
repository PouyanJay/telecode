import { redirect } from '@sveltejs/kit';

import { destroyRelaySession, listSessions } from '$lib/server/relay-api';
import { clearSessionCookie, getSessionToken } from '$lib/server/session-cookie';

import type { Actions, PageServerLoad } from './$types';

/**
 * The dashboard's own data: the persisted session registry (survives reloads; live status overlays it in
 * the page). The user + devices + repos come from the `(app)` layout load, so they aren't re-fetched here.
 */
export const load: PageServerLoad = async ({ cookies }) => {
  const token = getSessionToken(cookies);
  const sessions = token ? await listSessions(token) : [];
  return { sessions };
};

export const actions: Actions = {
  logout: async ({ cookies }) => {
    const token = getSessionToken(cookies);
    if (token) {
      await destroyRelaySession(token);
    }
    clearSessionCookie(cookies);
    redirect(303, '/signin');
  },
};
