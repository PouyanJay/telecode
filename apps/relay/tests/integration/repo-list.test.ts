import { encodeKey, generateSecretKey } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createOAuthTokenStore, type OAuthTokenStore } from '../../src/auth/oauth-token-store';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { type GithubClient, type GithubRepo } from '../../src/github/github-client';
import { buildRelay } from '../../src/relay';

/**
 * Phase 2 Task 7b — the launch form needs the user's repos. `GET /me/repos` resolves the user from the
 * bearer session, reads + decrypts their stored GitHub token (owner-only table), and lists repos via the
 * GitHub API. The API call is behind a `GithubClient` seam so the route + token storage + decryption are
 * exercised for real while the network is faked. Real relay + Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

const REPOS: GithubRepo[] = [
  {
    id: 1,
    fullName: 'octocat/hello',
    name: 'hello',
    owner: 'octocat',
    private: false,
    defaultBranch: 'main',
    cloneUrl: 'https://github.com/octocat/hello.git',
  },
  {
    id: 2,
    fullName: 'octocat/secret',
    name: 'secret',
    owner: 'octocat',
    private: true,
    defaultBranch: 'develop',
    cloneUrl: 'https://github.com/octocat/secret.git',
  },
];

describe('relay repo listing: GET /me/repos', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let tokenStore: OAuthTokenStore;
  let app: FastifyInstance;
  const seenTokens: string[] = [];

  // Fake GitHub: records the token it was handed, throws for a sentinel "revoked" token.
  const github: GithubClient = {
    async listRepos(accessToken: string): Promise<GithubRepo[]> {
      seenTokens.push(accessToken);
      if (accessToken === 'gho_revoked') {
        throw new Error('github 401 bad credentials');
      }
      return REPOS;
    },
  };

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: CHANNEL_SECRET });
    tokenStore = createOAuthTokenStore({
      db: handle,
      encryptionKey: encodeKey(generateSecretKey()),
    });

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
      oauthTokenStore: tokenStore,
      githubClient: github,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    seenTokens.length = 0;
    await admin.query('truncate table users restart identity cascade');
  });

  it('lists the user’s repos, calling GitHub with their decrypted token', async () => {
    const alice = await auth.createSession({ provider: 'github', providerUserId: 'octocat' });
    await tokenStore.storeToken({
      userId: alice.userId,
      accessToken: 'gho_alice_token',
      scope: 'repo',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/me/repos',
      headers: { authorization: `Bearer ${alice.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connected: true,
      repos: [
        {
          id: 1,
          full_name: 'octocat/hello',
          name: 'hello',
          owner: 'octocat',
          private: false,
          default_branch: 'main',
          clone_url: 'https://github.com/octocat/hello.git',
        },
        {
          id: 2,
          full_name: 'octocat/secret',
          name: 'secret',
          owner: 'octocat',
          private: true,
          default_branch: 'develop',
          clone_url: 'https://github.com/octocat/secret.git',
        },
      ],
    });
    // The relay handed GitHub the decrypted token (never the ciphertext).
    expect(seenTokens).toEqual(['gho_alice_token']);
  });

  it('reports not-connected (no GitHub call) when the user has no stored token', async () => {
    const dev = await auth.createSession({ provider: 'dev', providerUserId: 'dev-user' });

    const res = await app.inject({
      method: 'GET',
      url: '/me/repos',
      headers: { authorization: `Bearer ${dev.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false, repos: [] });
    expect(seenTokens).toEqual([]);
  });

  it('returns 502 when the GitHub call fails (e.g. a revoked token)', async () => {
    const bob = await auth.createSession({ provider: 'github', providerUserId: 'bob' });
    await tokenStore.storeToken({ userId: bob.userId, accessToken: 'gho_revoked', scope: 'repo' });

    const res = await app.inject({
      method: 'GET',
      url: '/me/repos',
      headers: { authorization: `Bearer ${bob.token}` },
    });

    expect(res.statusCode).toBe(502);
  });

  it('rejects a request with no / invalid session token', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/repos' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/me/repos',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
  });
});
