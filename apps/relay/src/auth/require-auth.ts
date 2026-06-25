import type { FastifyReply, FastifyRequest } from 'fastify';

import { type AuthService } from './auth-service';
import { bearerToken } from './bearer';

/**
 * Resolve the authenticated user id from the request's bearer session token, or send a 401 and return
 * null. Shared by every `/me/*` route + `/channel-token` so the auth gate lives in one place (the relay
 * always derives the user from the validated token, never from the client). A handler does:
 * `const userId = await requireUser(request, reply, auth); if (!userId) return;`
 */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  const userId = await auth.validateSession(token);
  if (!userId) {
    await reply.code(401).send({ error: 'invalid_session' });
    return null;
  }
  return userId;
}
