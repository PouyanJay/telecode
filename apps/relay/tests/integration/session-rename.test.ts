import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { hashDeviceToken } from '../../src/device-auth';
import { runMigrations } from '../../src/db/migrate';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { createSessionRegistry, type SessionRegistry } from '../../src/registry/session-registry';
import { makeEnvelope } from '@telecode/protocol';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Session rename (ux Phase 6 T6), relay leg. `PATCH /me/sessions/:id` stores the user's SEALED title
 * override in `sealed_title`/`sealed_title_nonce` — a blob OPAQUE to the relay (invariant #5), separate
 * from `sealed_meta` so a later derived title can't clobber it — and broadcasts a `session.title` frame to
 * watching browsers so every tab updates live. A reset-to-derived (`{ sealed_title: null }`) clears the
 * columns and broadcasts the cleartext `{ reset: true }` marker. RLS scopes every write to the owner.
 * Real relay, real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SEALED_TITLE = 'c2VhbGVkLXRpdGxlLWNpcGhlcnRleHQ=';
const TITLE_NONCE = 'BBBBBBBBBBBBBBBB';

describe('session rename: PATCH /me/sessions/:id', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let devices: DeviceRegistry;
  let sessions: SessionRegistry;
  let relayUrl: string;
  const relayLogs: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: 'channel-secret-test' });
    devices = createDeviceRegistry(handle);
    sessions = createSessionRegistry(handle);

    app = await buildRelay({
      // Captured (not silent): the forgery-drop test uses the relay's own warn line as its barrier.
      logger: pino({ level: 'info' }, { write: (chunk: string) => relayLogs.push(chunk) }),
      auth: { service: auth, serviceSecret: 'svc-secret-test' },
      deviceRegistry: devices,
      sessionRegistry: sessions,
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

  /** A user + device + one session, returning the ids and the user's session/channel + device tokens. */
  async function seedSession(providerUserId: string): Promise<{
    userId: string;
    token: string;
    channelToken: string;
    deviceId: string;
    deviceToken: string;
    sessionId: string;
  }> {
    const user = await auth.createSession({ provider: 'dev', providerUserId });
    const channelToken = await auth.mintChannelToken(user.userId);
    // A real device token so a daemon can authenticate its hello (the relay hashes what it presents).
    const deviceToken = `daemon-token-${providerUserId}`;
    const deviceId = await devices.createDevice({
      userId: user.userId,
      name: `${providerUserId}-laptop`,
      deviceTokenHash: hashDeviceToken(deviceToken),
    });
    const row = await admin.query<{ id: string }>(
      "insert into sessions (user_id, device_id, status) values ($1, $2, 'running') returning id",
      [user.userId, deviceId],
    );
    return {
      userId: user.userId,
      token: user.token,
      channelToken,
      deviceId,
      deviceToken,
      sessionId: row.rows[0]!.id,
    };
  }

  async function readSealedTitle(
    sessionId: string,
  ): Promise<{ sealed_title: string | null; sealed_title_nonce: string | null } | undefined> {
    const res = await admin.query<{
      sealed_title: string | null;
      sealed_title_nonce: string | null;
    }>('select sealed_title, sealed_title_nonce from sessions where id = $1', [sessionId]);
    return res.rows[0];
  }

  it('stores a sealed rename override and broadcasts session.title to watching browsers', async () => {
    const alice = await seedSession('alice');
    const browser = await connectBrowser(
      relayUrl,
      alice.userId,
      alice.deviceId,
      alice.channelToken,
    );
    const onFrame = waitForEnvelope(browser, (e) => e.type === 'session.title');

    const res = await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { sealed_title: SEALED_TITLE, sealed_title_nonce: TITLE_NONCE },
    });
    expect(res.statusCode).toBe(204);

    // The opaque blob is persisted verbatim (the relay never reads it).
    expect(await readSealedTitle(alice.sessionId)).toEqual({
      sealed_title: SEALED_TITLE,
      sealed_title_nonce: TITLE_NONCE,
    });

    // Every tab hears it: the broadcast carries the ciphertext + nonce unchanged.
    const frame = await onFrame;
    expect(frame.session_id).toBe(alice.sessionId);
    expect(frame.payload).toBe(SEALED_TITLE);
    expect(frame.nonce).toBe(TITLE_NONCE);
    browser.close();
  });

  it('resets to derived (clears the columns) and broadcasts a cleartext reset marker', async () => {
    const alice = await seedSession('alice');
    // Start from a set override so the reset has something to clear.
    await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { sealed_title: SEALED_TITLE, sealed_title_nonce: TITLE_NONCE },
    });

    const browser = await connectBrowser(
      relayUrl,
      alice.userId,
      alice.deviceId,
      alice.channelToken,
    );
    const onFrame = waitForEnvelope(browser, (e) => e.type === 'session.title');

    const res = await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { sealed_title: null },
    });
    expect(res.statusCode).toBe(204);
    expect(await readSealedTitle(alice.sessionId)).toEqual({
      sealed_title: null,
      sealed_title_nonce: null,
    });

    const frame = await onFrame;
    expect(frame.nonce).toBe('');
    expect(frame.payload).toEqual({ reset: true });
    browser.close();
  });

  it('returns the sealed override from GET /me/sessions (cold-load source)', async () => {
    const alice = await seedSession('alice');
    await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { sealed_title: SEALED_TITLE, sealed_title_nonce: TITLE_NONCE },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me/sessions',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const body = res.json<{
      sessions: { id: string; sealed_title: string | null; sealed_title_nonce: string | null }[];
    }>();
    const session = body.sessions.find((s) => s.id === alice.sessionId);
    expect(session?.sealed_title).toBe(SEALED_TITLE);
    expect(session?.sealed_title_nonce).toBe(TITLE_NONCE);
  });

  it('refuses to rename another user’s session (RLS-scoped 404)', async () => {
    const alice = await seedSession('alice');
    const bob = await seedSession('bob');
    const res = await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      headers: { authorization: `Bearer ${bob.token}` },
      payload: { sealed_title: SEALED_TITLE, sealed_title_nonce: TITLE_NONCE },
    });
    expect(res.statusCode).toBe(404);
    // Alice's row is untouched — no cross-tenant write.
    expect(await readSealedTitle(alice.sessionId)).toEqual({
      sealed_title: null,
      sealed_title_nonce: null,
    });
  });

  it('rejects a body missing the nonce (400)', async () => {
    const alice = await seedSession('alice');
    const res = await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { sealed_title: SEALED_TITLE },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized sealed title blob (400) — the relay can’t be made to bloat a row', async () => {
    const alice = await seedSession('alice');
    const res = await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      headers: { authorization: `Bearer ${alice.token}` },
      // One char past the 8192 ceiling that mirrors the DB CHECK in migration 0009.
      payload: { sealed_title: 'A'.repeat(8193), sealed_title_nonce: TITLE_NONCE },
    });
    expect(res.statusCode).toBe(400);
    expect(await readSealedTitle(alice.sessionId)).toEqual({
      sealed_title: null,
      sealed_title_nonce: null,
    });
  });

  it('returns 400 for a non-uuid session id', async () => {
    const alice = await seedSession('alice');
    const res = await app.inject({
      method: 'PATCH',
      url: '/me/sessions/not-a-uuid',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { sealed_title: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown (well-formed) session id', async () => {
    const alice = await seedSession('alice');
    const res = await app.inject({
      method: 'PATCH',
      url: `/me/sessions/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { sealed_title: null },
    });
    expect(res.statusCode).toBe(404);
  });

  it('drops a daemon-forged session.title frame (rename is REST-only, never a raw frame)', async () => {
    const alice = await seedSession('alice');
    const daemon = await connectDaemon(relayUrl, alice.userId, alice.deviceId, {
      token: alice.deviceToken,
    });
    const browser = await connectBrowser(
      relayUrl,
      alice.userId,
      alice.deviceId,
      alice.channelToken,
    );
    // A forged session.title from the daemon must NOT reach browsers (it would clobber the title with an
    // unbounded, unpersisted value). The relay's own drop-warn line is the barrier: once it appears, the
    // forged frame has been fully processed-and-dropped.
    const dropsBefore = relayLogs.length;
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.title',
          userId: alice.userId,
          deviceId: alice.deviceId,
          sessionId: alice.sessionId,
          payload: 'Zm9yZ2Vk',
          nonce: TITLE_NONCE,
        }),
      ),
    );
    await vi.waitUntil(
      () =>
        relayLogs
          .slice(dropsBefore)
          .some((l) => l.includes('dropped a relay-internal frame from a daemon')),
      { timeout: 3000 },
    );

    // The channel still works: a legitimate REST rename after the drop DOES reach the browser, and its
    // blob — never the forged 'Zm9yZ2Vk' — is the first session.title the browser sees.
    const onFrame = waitForEnvelope(browser, (e) => e.type === 'session.title');
    await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { sealed_title: SEALED_TITLE, sealed_title_nonce: TITLE_NONCE },
    });
    expect((await onFrame).payload).toBe(SEALED_TITLE);
    daemon.close();
    browser.close();
  });

  it('rejects an unauthenticated rename', async () => {
    const alice = await seedSession('alice');
    const res = await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${alice.sessionId}`,
      payload: { sealed_title: null },
    });
    expect(res.statusCode).toBe(401);
  });
});
