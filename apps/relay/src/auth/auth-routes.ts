import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { type AuthService, providerIdentitySchema } from './auth-service';

/**
 * Relay HTTP auth endpoints, all called server-to-server by the SvelteKit web tier (the browser never
 * calls these directly — it holds an httpOnly cookie). `/auth/session` is guarded by a shared service
 * secret (only the web backend knows it); the others are authorized by the bearer session token the web
 * reads from that cookie.
 */
export interface AuthRoutesOptions {
  readonly serviceSecret: string;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  options: AuthRoutesOptions,
): void {
  // Web → relay: mint a login session for a verified OAuth identity (service-secret guarded).
  app.post('/auth/session', async (request, reply) => {
    const secret = request.headers['x-telecode-service-secret'];
    if (typeof secret !== 'string' || !constantTimeEquals(secret, options.serviceSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = providerIdentitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const session = await auth.createSession(parsed.data);
    return reply.send({
      token: session.token,
      user_id: session.userId,
      expires_at: session.expiresAt.toISOString(),
    });
  });

  // Web → relay: exchange a valid session for a short-lived channel token (for the browser WS).
  app.post('/channel-token', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const userId = await auth.validateSession(token);
    if (!userId) {
      return reply.code(401).send({ error: 'invalid_session' });
    }
    const channelToken = await auth.mintChannelToken(userId);
    return reply.send({ channel_token: channelToken, user_id: userId });
  });

  // Web → relay: revoke a session (logout).
  app.delete('/auth/session', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    await auth.destroySession(token);
    return reply.code(204).send();
  });
}
