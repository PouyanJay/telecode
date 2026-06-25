import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import { makeEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import {
  createPushSubscriptionStore,
  type PushSubscriptionStore,
} from '../../src/push/push-subscription-store';
import {
  type PushPayload,
  type PushSender,
  type StoredPushSubscription,
} from '../../src/push/push-sender';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, waitForEnvelope } from '../_helpers/ws';

/**
 * Phase 2 Task 10a — get pinged when a session needs input. The browser registers a push subscription
 * (BFF endpoint → owner-only table); when a session goes `awaiting_input`, the relay sends a push
 * carrying only routing metadata (session id + deep-link), behind a `PushSender` seam so no real push
 * service is needed. Real relay + Postgres + in-process daemon.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

describe('relay web push: subscriptions + push on awaiting_input', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let store: PushSubscriptionStore;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;
  let sessionToken: string;
  const sends: { endpoint: string; payload: PushPayload }[] = [];

  const sender: PushSender = {
    async send(subscription: StoredPushSubscription, payload: PushPayload) {
      sends.push({ endpoint: subscription.endpoint, payload });
      return { gone: false };
    },
  };

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    await admin.query('truncate table users restart identity cascade');

    auth = createAuthService({ db: handle, channelTokenSecret: CHANNEL_SECRET });
    store = createPushSubscriptionStore(handle);
    const session = await auth.createSession({ provider: 'dev', providerUserId: 'push' });
    userId = session.userId;
    sessionToken = session.token;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'lap', 'h') returning id",
      [userId],
    );
    deviceId = d.rows[0]!.id;

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
      sessionRegistry: createSessionRegistry(handle),
      push: { store, sender },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    // Each run blocks at a tool gate → the session parks at awaiting_input (the push trigger).
    daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      logger: pino({ level: 'silent' }),
      agentAdapter: createFakeAgentAdapter([
        { type: 'tool_use', toolName: 'Write', input: { path: 'x' } },
      ]),
    });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon?.stop();
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    sends.length = 0;
    await admin.query('truncate table push_subscriptions, sessions');
  });

  async function postSubscription(body: Record<string, unknown>, token = sessionToken) {
    return await app.inject({
      method: 'POST',
      url: '/me/push-subscriptions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it('stores a subscription from the browser and removes it on unsubscribe', async () => {
    const sub = { endpoint: 'https://push.example/ep-1', keys: { p256dh: 'pub', auth: 'sec' } };
    const res = await postSubscription(sub);
    expect(res.statusCode).toBe(201);
    expect(await store.listByUser(userId)).toEqual([
      { endpoint: sub.endpoint, p256dh: 'pub', auth: 'sec' },
    ]);

    const del = await app.inject({
      method: 'DELETE',
      url: '/me/push-subscriptions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      payload: { endpoint: sub.endpoint },
    });
    expect(del.statusCode).toBe(204);
    expect(await store.listByUser(userId)).toEqual([]);
  });

  it('rejects an unauthenticated or malformed subscription', async () => {
    const unauthed = await postSubscription(
      { endpoint: 'x', keys: { p256dh: 'a', auth: 'b' } },
      'nope',
    );
    expect(unauthed.statusCode).toBe(401);
    const malformed = await postSubscription({ endpoint: 'x' });
    expect(malformed.statusCode).toBe(400);
  });

  it('pushes a routing-only notification when a session goes awaiting_input', async () => {
    await store.save({ userId, endpoint: 'https://push.example/ep-2', p256dh: 'pub', auth: 'sec' });
    const browser = await connectBrowser(
      relayUrl,
      userId,
      deviceId,
      await auth.mintChannelToken(userId),
    );

    browser.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.launch', userId, deviceId, payload: { prompt: 'go' } }),
      ),
    );
    // The run reaches the gate → relay marks awaiting_input → sends the push.
    const gate = await waitForEnvelope(
      browser,
      (e: Envelope) => e.type === 'agent.permission_request',
    );
    const sessionId = gate.session_id as string;

    // The push is fire-and-forget (never blocks frame routing), so await its delivery to the fake sender.
    await vi.waitFor(() => expect(sends).toHaveLength(1), { timeout: 5000 });
    // Routing metadata only (id + deep-link) — never the prompt.
    expect(sends[0]!.endpoint).toBe('https://push.example/ep-2');
    expect(sends[0]!.payload.data).toEqual({ sessionId, url: `/sessions/${sessionId}` });
    expect(JSON.stringify(sends[0]!.payload)).not.toContain('go');

    browser.close();
  });
});
