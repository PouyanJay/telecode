import type { FastifyReply, FastifyRequest } from 'fastify';

import { type AuthService, type SessionUser } from './auth-service';
import { bearerToken } from './bearer';
import { isOperator } from './operator';

/**
 * Operator gate for instance-wide controls (the infra scale-to-zero toggles) — the counterpart to
 * {@link requireUser}. Resolve the user from the validated session token and require their email to be on
 * the operator allowlist; otherwise reply 401 (no/invalid session), 403 (not an operator), or 503 (the
 * session lookup failed). A handler does: `if (!(await requireOperator(...))) return reply;`.
 *
 * It returns a boolean rather than throwing so the handler can `return reply` inline — a Fastify handler
 * must return after replying, and an exception here would bypass that and surface as an unhandled rejection.
 */
export async function requireOperator(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
  operatorEmails: readonly string[],
): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  let user: SessionUser | null;
  try {
    user = await auth.getSessionUser(token);
  } catch (err) {
    // A DB outage during the lookup is a transient server fault, not an auth failure — and must not leak.
    request.log.error({ err }, 'operator gate: session lookup failed');
    await reply.code(503).send({ error: 'service_unavailable' });
    return false;
  }
  if (!user) {
    await reply.code(401).send({ error: 'invalid_session' });
    return false;
  }
  if (!isOperator(user.email, operatorEmails)) {
    request.log.warn({ userId: user.id }, 'operator gate: non-operator denied');
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}
