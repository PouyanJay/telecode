import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { hashDeviceToken } from '../../src/device-auth';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { createSessionRegistry, type SessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Device registry HTTP layer — `GET /me/devices` (list, to pick the channel a browser watches, incl. the
 * `os` descriptor) and `DELETE /me/devices/:id` (revoke). Session-token authed; the user is derived from
 * the token and results are RLS-scoped to the owner. Real relay + Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

describe('relay device listing: GET /me/devices', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let registry: DeviceRegistry;
  let sessions: SessionRegistry;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: CHANNEL_SECRET });
    registry = createDeviceRegistry(handle);
    sessions = createSessionRegistry(handle);

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
      deviceRegistry: registry,
      sessionRegistry: sessions,
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

  it('returns the authenticated user’s active devices, scoped to that user', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob' });

    const aliceDeviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'alice-laptop',
      deviceTokenHash: 'hash-a',
    });
    await registry.createDevice({
      userId: bob.userId,
      name: 'bob-laptop',
      deviceTokenHash: 'hash-b',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ devices: { id: string; name: string }[] }>();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ id: aliceDeviceId, name: 'alice-laptop' });
  });

  it('returns each device’s public key (base64) for E2E key exchange, null when unset', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const publicKey = `${'A'.repeat(43)}=`;
    const keyedId = await registry.createDevice({
      userId: alice.userId,
      name: 'keyed-laptop',
      deviceTokenHash: 'hash-keyed',
      publicKey,
    });
    const unkeyedId = await registry.createDevice({
      userId: alice.userId,
      name: 'legacy-laptop',
      deviceTokenHash: 'hash-legacy',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ devices: { id: string; public_key: string | null }[] }>();
    const byId = new Map(body.devices.map((d) => [d.id, d.public_key]));
    expect(byId.get(keyedId)).toBe(publicKey);
    expect(byId.get(unkeyedId)).toBeNull();
  });

  it('omits revoked devices', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const deviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'old-laptop',
      deviceTokenHash: 'hash-old',
    });
    await admin.query('update devices set revoked_at = now() where id = $1', [deviceId]);

    const res = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ devices: unknown[] }>().devices).toHaveLength(0);
  });

  it('returns each device’s os descriptor, null when unset', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const withOsId = await registry.createDevice({
      userId: alice.userId,
      name: 'mbp',
      deviceTokenHash: 'hash-os',
      os: 'macOS 15.4',
    });
    const withoutOsId = await registry.createDevice({
      userId: alice.userId,
      name: 'legacy',
      deviceTokenHash: 'hash-no-os',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const byId = new Map(
      res.json<{ devices: { id: string; os: string | null }[] }>().devices.map((d) => [d.id, d.os]),
    );
    expect(byId.get(withOsId)).toBe('macOS 15.4');
    expect(byId.get(withoutOsId)).toBeNull();
  });

  it('revokes the user’s own device (it then drops out of the list)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const deviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'to-revoke',
      deviceTokenHash: 'hash-rev',
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${deviceId}`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(list.json<{ devices: unknown[] }>().devices).toHaveLength(0);
  });

  it('ends the revoked device’s non-terminal sessions (every state), leaving other devices/users untouched', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const deviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'to-revoke',
      deviceTokenHash: 'hash-rev-cascade',
    });
    const keeperId = await registry.createDevice({
      userId: alice.userId,
      name: 'keeper',
      deviceTokenHash: 'hash-keeper',
    });
    // On the device being revoked — one of EVERY non-terminal state (all must end), plus an already-done one
    // (stays). `starting` is left as-created; `offline_paused` is forced directly since the registry never
    // writes it (a revoked device must still be fully cleared).
    const starting = await sessions.createSession({ userId: alice.userId, deviceId });
    const running = await sessions.createSession({ userId: alice.userId, deviceId });
    await sessions.markRunning({ userId: alice.userId, sessionId: running });
    const awaiting = await sessions.createSession({ userId: alice.userId, deviceId });
    await sessions.markAwaitingInput({ userId: alice.userId, sessionId: awaiting });
    const paused = await sessions.createSession({ userId: alice.userId, deviceId });
    await admin.query("update sessions set status = 'offline_paused' where id = $1", [paused]);
    const alreadyDone = await sessions.createSession({ userId: alice.userId, deviceId });
    await sessions.markEnded({ userId: alice.userId, sessionId: alreadyDone, status: 'done' });
    // A running session on ANOTHER device of alice's — untouched (reconcile is per-device).
    const keeperRunning = await sessions.createSession({
      userId: alice.userId,
      deviceId: keeperId,
    });
    await sessions.markRunning({ userId: alice.userId, sessionId: keeperRunning });
    // A running session belonging to a DIFFERENT user — untouched (RLS / cross-user isolation).
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob' });
    const bobDeviceId = await registry.createDevice({
      userId: bob.userId,
      name: 'bob-laptop',
      deviceTokenHash: 'hash-bob-cascade',
    });
    const bobRunning = await sessions.createSession({ userId: bob.userId, deviceId: bobDeviceId });
    await sessions.markRunning({ userId: bob.userId, sessionId: bobRunning });

    const del = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${deviceId}`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(del.statusCode).toBe(204);

    const rows = await sessions.listByUser(alice.userId);
    const statusOf = (id: string): string | undefined => rows.find((s) => s.id === id)?.status;
    // Every non-terminal state on the revoked device is now terminal.
    expect(statusOf(starting)).toBe('done');
    expect(statusOf(running)).toBe('done');
    expect(statusOf(awaiting)).toBe('done');
    expect(statusOf(paused)).toBe('done');
    expect(statusOf(alreadyDone)).toBe('done');
    // A different device of the same user is untouched.
    expect(statusOf(keeperRunning)).toBe('running');
    // Another user's session is untouched.
    const bobRows = await sessions.listByUser(bob.userId);
    expect(bobRows.find((s) => s.id === bobRunning)?.status).toBe('running');
  });

  it('broadcasts session.ended to a watching browser for each session the revoke cascade ends', async () => {
    // Honesty pass T3: the cascade used to be DB-only — an open dashboard kept showing the revoked
    // device's sessions as running until a manual refresh. Now it broadcasts the same synthetic
    // `session.ended` the reconcile path sends, so live UIs clear immediately.
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const deviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'watched-revoke',
      deviceTokenHash: 'hash-watched-revoke',
    });
    const running = await sessions.createSession({ userId: alice.userId, deviceId });
    await sessions.markRunning({ userId: alice.userId, sessionId: running });
    const awaiting = await sessions.createSession({ userId: alice.userId, deviceId });
    await sessions.markAwaitingInput({ userId: alice.userId, sessionId: awaiting });

    const relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
    const browser = await connectBrowser(
      relayUrl,
      alice.userId,
      deviceId,
      await auth.mintChannelToken(alice.userId),
    );
    const endedFrames = Promise.all(
      [running, awaiting].map((sessionId) =>
        waitForEnvelope(browser, (e) => e.type === 'session.ended' && e.session_id === sessionId),
      ),
    );

    const del = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${deviceId}`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(del.statusCode).toBe(204);

    for (const frame of await endedFrames) {
      expect((frame.payload as { status: string }).status).toBe('done');
    }
    browser.close();
  });

  it('revoke succeeds when nobody is watching (broadcast has no audience, cascade still runs)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const deviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'unwatched-revoke',
      deviceTokenHash: 'hash-unwatched-revoke',
    });
    const running = await sessions.createSession({ userId: alice.userId, deviceId });
    await sessions.markRunning({ userId: alice.userId, sessionId: running });

    const del = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${deviceId}`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(del.statusCode).toBe(204);
    const rows = await sessions.listByUser(alice.userId);
    expect(rows.find((s) => s.id === running)?.status).toBe('done');
  });

  it('does not leak the revoke broadcast to a browser watching a different device', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const keeperToken = 'dt_scoped-keeper';
    const revokedId = await registry.createDevice({
      userId: alice.userId,
      name: 'to-revoke-scoped',
      deviceTokenHash: 'hash-scoped-revoke',
    });
    const keeperId = await registry.createDevice({
      userId: alice.userId,
      name: 'keeper-scoped',
      deviceTokenHash: hashDeviceToken(keeperToken),
    });
    const running = await sessions.createSession({ userId: alice.userId, deviceId: revokedId });
    await sessions.markRunning({ userId: alice.userId, sessionId: running });

    // The browser watches the KEEPER's channel — the revoked device's frames must not reach it. The
    // keeper daemon exists only to provide a deterministic ordering barrier on the browser's socket.
    const relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
    const daemon = await connectDaemon(relayUrl, alice.userId, keeperId, keeperToken);
    const browser = await connectBrowser(
      relayUrl,
      alice.userId,
      keeperId,
      await auth.mintChannelToken(alice.userId),
    );
    const frames: string[] = [];
    browser.on('message', (raw: Buffer) => frames.push(raw.toString()));

    const del = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${revokedId}`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(del.statusCode).toBe(204);

    // Barrier: the broadcast (if wrongly scoped) was already written during the DELETE; an echo.reply
    // sent now arrives after it on the browser's FIFO socket, so awaiting it flushes any stray frame
    // into `frames`. No timing waits.
    const replied = waitForEnvelope(browser, (e) => e.type === 'echo.reply');
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'echo.reply',
          userId: alice.userId,
          deviceId: keeperId,
          payload: { text: 'barrier' },
        }),
      ),
    );
    await replied;
    expect(frames.some((f) => f.includes('session.ended'))).toBe(false);
    browser.close();
    daemon.close();
  });

  it('cannot revoke another user’s device (RLS-scoped → 404)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob' });
    const bobDeviceId = await registry.createDevice({
      userId: bob.userId,
      name: 'bob-laptop',
      deviceTokenHash: 'hash-bob',
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${bobDeviceId}`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(del.statusCode).toBe(404);
    // Bob's device is untouched.
    const bobList = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(bobList.json<{ devices: unknown[] }>().devices).toHaveLength(1);
  });

  it('returns 404 when deleting a device that does not exist', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/me/devices/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when the device id is not a uuid', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/me/devices/not-a-uuid',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a revoke with no session token', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/me/devices/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no / invalid session token', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/devices' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
  });
});
