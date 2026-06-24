import type { FastifyInstance } from 'fastify';

import { bearerToken } from './bearer';
import { constantTimeEquals } from './secret-compare';
import { type AuthService, createSessionRequestSchema } from './auth-service';
import { type OAuthTokenStore } from './oauth-token-store';

/**
 * Relay HTTP auth endpoints, all called server-to-server by the SvelteKit web tier (the browser never
 * calls these directly — it holds an httpOnly cookie). `/auth/session` is guarded by a shared service
 * secret (only the web backend knows it); the others are authorized by the bearer session token the web
 * reads from that cookie.
 */
export interface AuthRoutesOptions {
  readonly serviceSecret: string;
  /** When present, an OAuth access token on `/auth/session` is persisted (encrypted) for the user. */
  readonly tokenStore?: OAuthTokenStore;
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
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const { oauthAccessToken, oauthScope, ...identity } = parsed.data;
    const session = await auth.createSession(identity);
    // Persist the OAuth token (encrypted) so the relay can later act on the user's behalf (e.g. list
    // repos). Never logged, never returned to the browser.
    if (oauthAccessToken && options.tokenStore) {
      await options.tokenStore.storeToken({
        userId: session.userId,
        accessToken: oauthAccessToken,
        ...(oauthScope !== undefined ? { scope: oauthScope } : {}),
      });
    }
    return reply.send({
      token: session.token,
      user_id: session.userId,
      expires_at: session.expiresAt.toISOString(),
    });
  });

  // Web → relay: resolve the current user from a session (for the web's hooks.server session load).
  app.get('/auth/me', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const user = await auth.getSessionUser(token);
    if (!user) {
      return reply.code(401).send({ error: 'invalid_session' });
    }
    return reply.send({
      id: user.id,
      display_name: user.displayName,
      email: user.email,
      avatar_url: user.avatarUrl,
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
