import { redirect } from '@sveltejs/kit';

import { listDevices } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies, params }) => {
  if (!locals.user) {
    redirect(303, '/signin');
  }
  const token = getSessionToken(cookies);
  const devices = token ? await listDevices(token) : [];
  return { user: locals.user, devices, sessionId: params.id };
};
