import { redirect } from '@sveltejs/kit';

import { destroyRelaySession } from '$lib/server/relay-api';
import { clearSessionCookie, getSessionToken } from '$lib/server/session-cookie';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  if (!locals.user) {
    redirect(303, '/signin');
  }
  return { user: locals.user };
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
