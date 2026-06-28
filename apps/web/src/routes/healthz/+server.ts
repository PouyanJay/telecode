import { json } from '@sveltejs/kit';

import type { RequestHandler } from './$types';

/** Liveness/readiness probe for the container platform — no auth, no I/O. Mirrors the relay's /healthz. */
export const GET: RequestHandler = () => json({ status: 'ok' });
