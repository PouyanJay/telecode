import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';

import { getProvider, listProviders } from '$lib/server/auth/providers';
import { createRelaySession } from '$lib/server/relay-api';
import { setSessionCookie } from '$lib/server/session-cookie';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  if (locals.user) {
    redirect(303, '/');
  }
  return { providers: listProviders() };
};

export const actions: Actions = {
  login: async ({ request, cookies, url }) => {
    const data = await request.formData();
    const providerValue = data.get('provider');
    const providerId = typeof providerValue === 'string' ? providerValue : '';
    const provider = getProvider(providerId);
    if (!provider) {
      return fail(400, { error: 'Unknown sign-in provider.' });
    }

    const start = provider.beginLogin(`${url.origin}/auth/${provider.id}/callback`);
    if (start.kind === 'redirect') {
      cookies.set('telecode_oauth_state', start.state, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: !dev,
        maxAge: 600,
      });
      redirect(303, start.url);
    }

    // Dev provider: identity is resolved immediately.
    const session = await createRelaySession(start.identity);
    setSessionCookie(cookies, session.token, session.expiresAt);
    redirect(303, '/');
  },
};
