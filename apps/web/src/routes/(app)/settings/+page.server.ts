import { fail } from '@sveltejs/kit';

import { getInfraSettings, setInfraSettings } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { Actions, PageServerLoad } from './$types';

/** Type-guard the toggle target so it narrows without an `as` cast. */
function isScaleTarget(value: unknown): value is 'web' | 'relay' {
  return value === 'web' || value === 'relay';
}

/**
 * Settings load: fetch the operator infra (scale-to-zero) state. The relay returns it only to operators with
 * the controls configured (Azure env present); for everyone else it's null and the page hides the panel. The
 * relay is the single authority — the web never decides who's an operator.
 */
export const load: PageServerLoad = async ({ cookies }) => {
  const token = getSessionToken(cookies);
  const infra = token ? await getInfraSettings(token) : null;
  return { infra };
};

export const actions: Actions = {
  // Pin an app always-on or let it scale to zero. The relay re-authorizes the operator and applies it to the
  // cloud; we return the freshly-read state so the toggles reflect what was actually applied.
  setScale: async ({ request, cookies }) => {
    const token = getSessionToken(cookies);
    if (!token) {
      return fail(401, { error: 'Your session expired — sign in again.' });
    }
    const form = await request.formData();
    const target = form.get('target');
    const alwaysOn = form.get('alwaysOn');
    if (!isScaleTarget(target) || (alwaysOn !== 'true' && alwaysOn !== 'false')) {
      return fail(400, { error: 'Invalid request.' });
    }
    const infra = await setInfraSettings(token, target, alwaysOn === 'true');
    if (!infra) {
      return fail(502, { error: 'Could not reach the cloud to change scaling. Please try again.' });
    }
    return { infra };
  },
};
