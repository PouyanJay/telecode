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

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const CHANNEL_SECRET = 'channel-secret-branches';
const SERVICE_SECRET = 'service-secret-branches';

/**
 * Branch listing for the launch picker (branch-launch Phase B): the relay lists a GitHub repo's
 * branches with the user's own decrypted token, the same trust path as /me/repos. Params are
 * validated at the boundary; the token never leaves the relay.
 */
describe('relay branch listing: GET /me/repos/:owner/:name/branches', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let tokenStore: OAuthTokenStore;
  let app: FastifyInstance;
  const listBranchCalls: { token: string; owner: string; name: string }[] = [];

  const github: GithubClient = {
    listRepos(): Promise<GithubRepo[]> {
      return Promise.resolve([]);
    },
    listBranches(accessToken: string, owner: string, name: string): Promise<string[]> {
      listBranchCalls.push({ token: accessToken, owner, name });
      if (accessToken === 'gho_revoked') {
        return Promise.reject(new Error('github 401 bad credentials'));
      }
      return Promise.resolve(['main', 'develop', 'feat/login']);
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
    listBranchCalls.length = 0;
    await admin.query('truncate table users restart identity cascade');
  });

  it("lists a repo's branches with the user's decrypted token", async () => {
    const alice = await auth.createSession({ provider: 'github', providerUserId: 'octocat' });
    await tokenStore.storeToken({
      userId: alice.userId,
      accessToken: 'gho_alice_token',
      scope: 'repo',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/me/repos/octocat/hello/branches',
      headers: { authorization: `Bearer ${alice.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connected: true,
      branches: ['main', 'develop', 'feat/login'],
    });
    expect(listBranchCalls).toEqual([
      { token: 'gho_alice_token', owner: 'octocat', name: 'hello' },
    ]);
  });

  it('reports not-connected (no GitHub call) without a stored token', async () => {
    const dev = await auth.createSession({ provider: 'dev', providerUserId: 'dev-user' });
    const res = await app.inject({
      method: 'GET',
      url: '/me/repos/octocat/hello/branches',
      headers: { authorization: `Bearer ${dev.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false, branches: [] });
    expect(listBranchCalls).toEqual([]);
  });

  it('maps a GitHub failure to 502 without leaking detail', async () => {
    const alice = await auth.createSession({ provider: 'github', providerUserId: 'octocat' });
    await tokenStore.storeToken({
      userId: alice.userId,
      accessToken: 'gho_revoked',
      scope: 'repo',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me/repos/octocat/hello/branches',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'github_unavailable' });
  });

  it('rejects malformed owner/name path params at the boundary (no GitHub call)', async () => {
    const alice = await auth.createSession({ provider: 'github', providerUserId: 'octocat' });
    await tokenStore.storeToken({
      userId: alice.userId,
      accessToken: 'gho_alice_token',
      scope: 'repo',
    });

    // Characters outside the GitHub-safe set → the route's own 400.
    const invalidChars = await app.inject({
      method: 'GET',
      url: `/me/repos/octocat/${encodeURIComponent('h$llo!')}/branches`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(invalidChars.statusCode).toBe(400);

    // A traversal segment is stopped even earlier (the router refuses it) — never reaches GitHub.
    const traversal = await app.inject({
      method: 'GET',
      url: `/me/repos/${encodeURIComponent('..')}/hello/branches`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(traversal.statusCode).toBeGreaterThanOrEqual(400);

    expect(listBranchCalls).toEqual([]);
  });

  it('requires a session token', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/repos/a/b/branches' });
    expect(res.statusCode).toBe(401);
  });
});
