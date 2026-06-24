import { redirect } from '@sveltejs/kit';

import { destroyRelaySession, listDevices, listSessions } from '$lib/server/relay-api';
import { clearSessionCookie, getSessionToken } from '$lib/server/session-cookie';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  if (!locals.user) {
    redirect(303, '/signin');
  }
  const token = getSessionToken(cookies);
  // The persisted session list survives UI restarts (reopen = reconnect); live status overlays it.
  const [devices, sessions] = token
    ? await Promise.all([listDevices(token), listSessions(token)])
    : [[], []];
  return { user: locals.user, devices, sessions };
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
