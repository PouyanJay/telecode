import { listSessions } from '$lib/server/relay-api';
import { getSessionToken } from '$lib/server/session-cookie';

import type { PageServerLoad } from './$types';

/**
 * The archived view's data (ux Phase 6 T7): the first page of the user's ARCHIVED sessions + the
 * cursor for more. Auth is guarded by the `(app)` layout; error ≠ empty carries through so an outage
 * never renders as "nothing archived".
 */
export const load: PageServerLoad = async ({ cookies }) => {
  const token = getSessionToken(cookies);
  const page = token
    ? await listSessions(token, { archived: true })
    : { ok: true, items: [], nextCursor: null };
  return {
    archivedSessions: page.items,
    archivedCursor: page.nextCursor,
    archivedError: !page.ok,
  };
};
