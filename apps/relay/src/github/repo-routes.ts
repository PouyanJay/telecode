import type { FastifyInstance } from 'fastify';
import { repoPathSegmentSchema } from '@telecode/protocol';
import { z } from 'zod';

import { type AuthService } from '../auth/auth-service';
import { type OAuthTokenStore } from '../auth/oauth-token-store';
import { requireUser } from '../auth/require-auth';
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
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;

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

/**
 * Owner/name flow into the GitHub API URL, so they are constrained at the boundary — the SAME rule
 * as the launch payload's repo ref (imported, so the two can never drift).
 */
const repoParamsSchema = z.object({
  owner: repoPathSegmentSchema,
  name: repoPathSegmentSchema,
});

/**
 * Web → relay: list one GitHub repo's branches for the launch drawer's base-branch picker (Phase B).
 * Same trust path as /me/repos — the user's stored token is decrypted relay-side and never returned;
 * `connected: false` means no linked GitHub token (the drawer falls back to the default branch only).
 */
export function registerRepoBranchesRoute(
  app: FastifyInstance,
  auth: AuthService,
  tokenStore: OAuthTokenStore,
  github: GithubClient,
): void {
  app.get('/me/repos/:owner/:name/branches', async (request, reply) => {
    const userId = await requireUser(request, reply, auth);
    if (!userId) return reply;

    const params = repoParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_repo' });
    }

    const stored = await tokenStore.getToken(userId);
    if (!stored) {
      return reply.send({ connected: false, branches: [] });
    }

    try {
      const branches = await github.listBranches(
        stored.accessToken,
        params.data.owner,
        params.data.name,
      );
      return reply.send({ connected: true, branches });
    } catch {
      // Token present but GitHub failed it — surface a clear upstream failure, never the detail.
      return reply.code(502).send({ error: 'github_unavailable' });
    }
  });
}
