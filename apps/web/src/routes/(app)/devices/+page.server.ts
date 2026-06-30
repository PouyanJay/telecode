import { fail } from '@sveltejs/kit';

import { revokeDevice } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { Actions } from './$types';

/** A device id is a uuid; validated at this trust boundary (the relay re-validates authoritatively). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revoke a paired device. The relay scopes the revoke to the authenticated owner (the user id comes from
 * the session token, never the client). On success SvelteKit reruns the `(app)` layout load, so the
 * device drops out of the list. Auth + device/repo loading otherwise come from the layout.
 */
export const actions: Actions = {
  revoke: async ({ request, cookies }) => {
    const token = getSessionToken(cookies);
    if (!token) {
      return fail(401, { error: 'Your session expired — sign in again.' });
    }
    // Validate the device id at this trust boundary, not just at the relay's.
    const deviceId = (await request.formData()).get('deviceId');
    if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId)) {
      return fail(400, { error: 'No device specified.' });
    }
    const result = await revokeDevice(token, deviceId);
    if (result.notFound) {
      return fail(404, { error: 'This device no longer exists or was already removed.' });
    }
    if (!result.ok) {
      return fail(400, { error: 'Could not revoke this device. Please try again.' });
    }
    return { revoked: true };
  },
};
