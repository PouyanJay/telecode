import type { FastifyInstance } from 'fastify';

import { type AuthService } from '../auth/auth-service';
import { bearerToken } from '../auth/bearer';
import { type OAuthTokenStore } from '../auth/oauth-token-store';
import { type GithubClient } from './github-client';

/**
 * Web → relay: list the authenticated user's GitHub repos for the launch picker. Session-token authed;
 * the relay derives the user from the token, reads + decrypts that user's stored GitHub token (owner-only
 * table), and calls GitHub on their behalf. The token itself never leaves the relay — only repo metadata
 * is returned. `connected: false` (with no GitHub call) means the user hasn't linked a GitHub token yet.
 */
export function registerRepoListRoute(
  app: FastifyInstance,
  auth: AuthService,
  tokenStore: OAuthTokenStore,
  github: GithubClient,
): void {
  app.get('/me/repos', async (request, reply) => {
    const sessionToken = bearerToken(request);
    if (!sessionToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const userId = await auth.validateSession(sessionToken);
    if (!userId) {
      return reply.code(401).send({ error: 'invalid_session' });
    }

    const stored = await tokenStore.getToken(userId);
    if (!stored) {
      return reply.send({ connected: false, repos: [] });
    }

    try {
      const repos = await github.listRepos(stored.accessToken);
      return reply.send({
        connected: true,
        repos: repos.map((repo) => ({
          id: repo.id,
          full_name: repo.fullName,
          name: repo.name,
          owner: repo.owner,
          private: repo.private,
          default_branch: repo.defaultBranch,
          clone_url: repo.cloneUrl,
        })),
      });
    } catch {
      // The token is present but GitHub rejected/failed it (e.g. revoked). Surface a clear upstream
      // failure (never the token or error detail) so the UI can prompt a reconnect.
      return reply.code(502).send({ error: 'github_unavailable' });
    }
  });
}
