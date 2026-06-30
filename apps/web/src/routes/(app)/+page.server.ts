import { redirect } from '@sveltejs/kit';

import { destroyRelaySession } from '$lib/server/relay-api';
import { clearSessionCookie, getSessionToken } from '$lib/server/session-cookie';

import type { Actions } from './$types';

/**
 * The dashboard reads the persisted session registry (`data.sessions`), the user, devices, and repos from
 * the `(app)` layout load — the shell counts sessions too, so the list lives there and isn't re-fetched
 * here. This module owns only the dashboard's logout action.
 */
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
