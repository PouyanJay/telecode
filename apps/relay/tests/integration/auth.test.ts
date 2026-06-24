import type { AddressInfo } from 'node:net';

import { makeEnvelope, parseEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { buildRelay } from '../../src/relay';

const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

const DEV_IDENTITY = { provider: 'dev', providerUserId: 'alice' };

describe('relay auth: sessions, channel tokens, and WS gating', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let app: FastifyInstance;
  let relayUrl: string;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: CHANNEL_SECRET });

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table users restart identity cascade');
  });

  describe('AuthService', () => {
    it('creates a session, upserts the user, and validates the token', async () => {
      const session = await auth.createSession({ ...DEV_IDENTITY, email: 'alice@example.com' });
      expect(session.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(await auth.validateSession(session.token)).toBe(session.userId);

      // Same identity again upserts the same user (no duplicate row).
      const again = await auth.createSession({ ...DEV_IDENTITY, email: 'alice2@example.com' });
      expect(again.userId).toBe(session.userId);
      const count = await admin.query<{ n: string }>('select count(*)::text as n from users');
      expect(count.rows[0]?.n).toBe('1');
    });

    it('rejects an unknown token and a destroyed session', async () => {
      expect(await auth.validateSession('not-a-real-token')).toBeNull();
      const session = await auth.createSession(DEV_IDENTITY);
      await auth.destroySession(session.token);
      expect(await auth.validateSession(session.token)).toBeNull();
    });

    it('treats an expired session as invalid', async () => {
      let clock = 1_700_000_000_000;
      const shortLived = createAuthService({
        db: handle,
        channelTokenSecret: CHANNEL_SECRET,
        sessionTtlMs: 1000,
        now: () => clock,
      });
      const session = await shortLived.createSession(DEV_IDENTITY);
      expect(await shortLived.validateSession(session.token)).toBe(session.userId);
      clock += 2000;
      expect(await shortLived.validateSession(session.token)).toBeNull();
    });

    it('mints and verifies a channel token, and rejects a tampered one', async () => {
      const session = await auth.createSession(DEV_IDENTITY);
      const channelToken = await auth.mintChannelToken(session.userId);
      expect(await auth.verifyChannelToken(channelToken)).toBe(session.userId);
      expect(await auth.verifyChannelToken(`${channelToken}x`)).toBeNull();
      expect(await auth.verifyChannelToken('garbage')).toBeNull();
    });
  });

  describe('HTTP routes', () => {
    it('guards /auth/session with the service secret', async () => {
      const denied = await app.inject({
        method: 'POST',
        url: '/auth/session',
        headers: { 'x-telecode-service-secret': 'wrong' },
        payload: DEV_IDENTITY,
      });
      expect(denied.statusCode).toBe(401);

      const ok = await app.inject({
        method: 'POST',
        url: '/auth/session',
        headers: { 'x-telecode-service-secret': SERVICE_SECRET },
        payload: DEV_IDENTITY,
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json<{ user_id: string; token: string }>();
      expect(typeof body.user_id).toBe('string');
      expect(typeof body.token).toBe('string');
    });

    it('exchanges a session for a channel token and revokes on logout', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/auth/session',
        headers: { 'x-telecode-service-secret': SERVICE_SECRET },
        payload: DEV_IDENTITY,
      });
      const token = created.json<{ token: string }>().token;

      const exchanged = await app.inject({
        method: 'POST',
        url: '/channel-token',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(exchanged.statusCode).toBe(200);
      const channelToken = exchanged.json<{ channel_token: string }>().channel_token;
      expect(await auth.verifyChannelToken(channelToken)).toBe(
        created.json<{ user_id: string }>().user_id,
      );

      // Bad bearer is rejected.
      const bad = await app.inject({
        method: 'POST',
        url: '/channel-token',
        headers: { authorization: 'Bearer nope' },
      });
      expect(bad.statusCode).toBe(401);

      // Logout revokes the session.
      const out = await app.inject({
        method: 'DELETE',
        url: '/auth/session',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(out.statusCode).toBe(204);
      expect(await auth.validateSession(token)).toBeNull();
    });
  });

  describe('WS hello gating', () => {
    it('admits a browser with a valid channel token', async () => {
      const session = await auth.createSession(DEV_IDENTITY);
      const channelToken = await auth.mintChannelToken(session.userId);

      const socket = new WebSocket(relayUrl);
      const ack = new Promise<void>((resolve, reject) => {
        socket.on('message', (raw: Buffer) => {
          if (parseEnvelope(JSON.parse(raw.toString()) as unknown).type === 'hello.ack') resolve();
        });
        socket.on('close', () => reject(new Error('closed before ack')));
        setTimeout(() => reject(new Error('no ack')), 3000);
      });
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));
      socket.send(
        JSON.stringify(
          makeEnvelope({
            type: 'hello',
            userId: session.userId,
            deviceId: 'd_any',
            payload: { role: 'browser', token: channelToken },
          }),
        ),
      );
      await expect(ack).resolves.toBeUndefined();
      socket.close();
    });

    it('rejects a browser with no / invalid channel token', async () => {
      const socket = new WebSocket(relayUrl);
      const closed = new Promise<number>((resolve, reject) => {
        socket.on('close', (code: number) => resolve(code));
        socket.on('message', () => reject(new Error('unexpected ack — should be rejected')));
        setTimeout(() => reject(new Error('socket not closed')), 3000);
      });
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));
      socket.send(
        JSON.stringify(
          makeEnvelope({
            type: 'hello',
            userId: 'u_x',
            deviceId: 'd_any',
            payload: { role: 'browser' },
          }),
        ),
      );
      expect(await closed).toBe(4001);
    });
  });
});
