import { encodeKey, generateSecretKey } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createOAuthTokenStore, type OAuthTokenStore } from '../../src/auth/oauth-token-store';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { buildRelay } from '../../src/relay';

/**
 * Phase 2 Task 7a — the user's GitHub access token is captured during OAuth and persisted server-side,
 * encrypted at rest, so the relay can later list repos on the user's behalf. `/auth/session` (the trusted
 * BFF call) carries the token; the relay seals it with `secretbox` and stores it in the owner-only
 * `oauth_tokens` table. Real relay + Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

describe('relay oauth token persistence: POST /auth/session', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let tokenStore: OAuthTokenStore;
  let app: FastifyInstance;

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
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table users restart identity cascade');
  });

  async function createSession(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { 'content-type': 'application/json', 'x-telecode-service-secret': SERVICE_SECRET },
      payload: body,
    });
  }

  it('persists the access token encrypted at rest and decrypts it back', async () => {
    const res = await createSession({
      provider: 'github',
      providerUserId: 'octocat',
      displayName: 'Octocat',
      oauthAccessToken: 'gho_secret_value_123',
      oauthScope: 'repo read:user user:email',
    });
    expect(res.statusCode).toBe(200);
    const { user_id: userId } = res.json<{ user_id: string }>();

    // The store decrypts the token back for the relay's own use.
    expect(await tokenStore.getToken(userId)).toEqual({
      accessToken: 'gho_secret_value_123',
      scope: 'repo read:user user:email',
    });

    // At rest the plaintext token never appears — the column holds only sealed ciphertext + a nonce.
    const raw = await admin.query<{ cipher: string; nonce: string; scope: string }>(
      'select access_token_cipher as cipher, access_token_nonce as nonce, scope from oauth_tokens where user_id = $1',
      [userId],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]!.cipher).not.toContain('gho_secret_value_123');
    expect(raw.rows[0]!.nonce.length).toBeGreaterThan(0);
  });

  it('creates a session with no token when none is supplied (dev sign-in path)', async () => {
    const res = await createSession({ provider: 'dev', providerUserId: 'dev-user' });
    expect(res.statusCode).toBe(200);
    const { user_id: userId } = res.json<{ user_id: string }>();
    expect(await tokenStore.getToken(userId)).toBeNull();
  });

  it('upserts the token on re-login (one row per user, latest value wins)', async () => {
    const first = await createSession({
      provider: 'github',
      providerUserId: 'octocat',
      oauthAccessToken: 'gho_first',
      oauthScope: 'repo',
    });
    const userId = first.json<{ user_id: string }>().user_id;

    await createSession({
      provider: 'github',
      providerUserId: 'octocat',
      oauthAccessToken: 'gho_second',
      oauthScope: 'repo',
    });

    expect(await tokenStore.getToken(userId)).toEqual({ accessToken: 'gho_second', scope: 'repo' });
    const count = await admin.query<{ n: string }>(
      'select count(*)::text as n from oauth_tokens where user_id = $1',
      [userId],
    );
    expect(count.rows[0]!.n).toBe('1');
  });
});
