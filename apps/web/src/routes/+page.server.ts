import { redirect } from '@sveltejs/kit';

import { destroyRelaySession, listDevices } from '$lib/server/relay-api';
import { clearSessionCookie, getSessionToken } from '$lib/server/session-cookie';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  if (!locals.user) {
    redirect(303, '/signin');
  }
  const token = getSessionToken(cookies);
  const devices = token ? await listDevices(token) : [];
  return { user: locals.user, devices };
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
