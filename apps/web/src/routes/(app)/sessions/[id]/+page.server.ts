import type { PageServerLoad } from './$types';

/**
 * The session view only needs the route's session id; the user, devices, and auth guard come from the
 * `(app)` layout load (the live transcript itself streams over the shared channel, not from here).
 */
export const load: PageServerLoad = ({ params }) => ({ sessionId: params.id });
