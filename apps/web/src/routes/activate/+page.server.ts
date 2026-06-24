import { fail, redirect } from '@sveltejs/kit';

import { approveDevice } from '$lib/server/relay-api';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  if (!locals.user) {
    redirect(303, '/signin');
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) {
      redirect(303, '/signin');
    }
    const data = await request.formData();
    const raw = data.get('code');
    const code = (typeof raw === 'string' ? raw : '').trim().toUpperCase();
    if (!code) {
      return fail(400, { error: 'Enter the code shown by the daemon.', code });
    }
    // user_id is the authenticated user's — never taken from the client.
    const ok = await approveDevice(code, locals.user.id);
    if (!ok) {
      return fail(400, {
        error: 'That code is invalid or expired. Run `npx telecode` again for a new one.',
        code,
      });
    }
    return { activated: true };
  },
};
