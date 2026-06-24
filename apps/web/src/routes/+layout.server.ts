import type { LayoutServerLoad } from './$types';

/** Expose the signed-in user (resolved in hooks.server) to every page. */
export const load: LayoutServerLoad = ({ locals }) => ({ user: locals.user });
