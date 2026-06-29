import { fail, redirect } from '@sveltejs/kit';

import { pairingInstructions } from '$lib/pairing-instructions';
import { approveDevice } from '$lib/server/relay-api';

import type { Actions } from './$types';

// A code that doesn't approve is invalid or expired; tell the user how to mint a fresh one in this
// environment. In dev `make run` reuses a healthy daemon (no new code), so point at a restart + the log.
const codeExpiredError = pairingInstructions.codeLocation
  ? `That code is invalid or expired. Restart the daemon and use the new code in \`${pairingInstructions.codeLocation}\`.`
  : `That code is invalid or expired. Run \`${pairingInstructions.command}\` again for a new one.`;

// Auth + device/repo loading are handled by the `(app)` layout; this route only owns the approve action.
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
      return fail(400, { error: codeExpiredError, code });
    }
    return { activated: true };
  },
};
