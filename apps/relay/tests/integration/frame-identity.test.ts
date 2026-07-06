import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Frame-identity binding (session-identity T2a, raised by the T1 security review): a peer's identity
 * is established ONCE, at `hello` — every later frame must carry the SAME (user_id, device_id), or the
 * relay drops it. Without this, an authenticated daemon could stamp another user's ids on a frame and
 * (bounded only by RLS + a guessed session UUID) write into their registry or broadcast into their
 * channel. The socket is the truth; the envelope is just a claim.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('relay: frames are bound to the authenticated peer identity', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let userA: string;
  let deviceA: string;
  let userB: string;
  let deviceB: string;
  let victimSession: string;
  const relayLogs: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    await admin.query('truncate table users restart identity cascade');
    const users = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'ident-a'), ('dev', 'ident-b') returning id",
    );
    userA = users.rows[0]!.id;
    userB = users.rows[1]!.id;
    const devices = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'a', 'ha'), ($2, 'b', 'hb') returning id",
      [userA, userB],
    );
    deviceA = devices.rows[0]!.id;
    deviceB = devices.rows[1]!.id;
    const session = await admin.query<{ id: string }>(
      "insert into sessions (user_id, device_id, status) values ($1, $2, 'running') returning id",
      [userB, deviceB],
    );
    victimSession = session.rows[0]!.id;

    app = await buildRelay({
      logger: pino({ level: 'info' }, { write: (chunk: string) => relayLogs.push(chunk) }),
      sessionRegistry: createSessionRegistry(handle),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  it('drops a daemon frame forging another user/device: no broadcast, no registry write', async () => {
    const attacker = await connectDaemon(relayUrl, userA, deviceA);
    const attackerBrowser = await connectBrowser(relayUrl, userA, deviceA);
    const victimBrowser = await connectBrowser(relayUrl, userB, deviceB);

    // The attacker's daemon (authenticated as A) stamps B's ids on a terminal frame for B's session.
    const before = relayLogs.length;
    attacker.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.ended',
          userId: userB,
          deviceId: deviceB,
          sessionId: victimSession,
          status: 'error',
          payload: { status: 'error' },
        }),
      ),
    );
    await vi.waitUntil(
      () =>
        relayLogs.slice(before).some((l) => l.includes('does not match the authenticated peer')),
      { timeout: 3000 },
    );

    // The victim's registry row is untouched.
    const row = await admin.query<{ status: string }>('select status from sessions where id = $1', [
      victimSession,
    ]);
    expect(row.rows[0]?.status).toBe('running');

    // The victim's browser heard nothing — the forged frame was never broadcast to B's channel.
    const victimHeard = waitForEnvelope(victimBrowser, () => true, 400).then(
      () => 'delivered',
      () => 'silent',
    );
    expect(await victimHeard).toBe('silent');

    // The attacker's own channel still works — the socket was dropped-the-frame, not killed.
    const ownChannelFrame = waitForEnvelope(attackerBrowser, (e) => e.type === 'echo.reply');
    attacker.send(
      JSON.stringify(
        makeEnvelope({
          type: 'echo.reply',
          userId: userA,
          deviceId: deviceA,
          payload: { text: 'me' },
        }),
      ),
    );
    await ownChannelFrame;

    attacker.close();
    attackerBrowser.close();
    victimBrowser.close();
  });

  it('drops a frame that arrives before hello (unknown role), then works after hello', async () => {
    const { WebSocket } = await import('ws');
    const raw = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      raw.once('open', () => resolve());
      raw.once('error', reject);
    });

    // A frame before any hello has no authenticated identity to match — it must be dropped (silently:
    // pre-hello noise stays at debug so it can't be used as a log-spam vector), never acted on.
    const before = relayLogs.length;
    raw.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.ended',
          userId: userB,
          deviceId: deviceB,
          sessionId: victimSession,
          status: 'error',
          payload: { status: 'error' },
        }),
      ),
    );
    // The proof it was dropped: the victim's row never changes, and no forgery warning is logged for it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      relayLogs.slice(before).some((l) => l.includes('does not match the authenticated peer')),
    ).toBe(false);
    const row = await admin.query<{ status: string }>('select status from sessions where id = $1', [
      victimSession,
    ]);
    expect(row.rows[0]?.status).toBe('running');

    raw.close();
  });

  it('rejects a second hello on an already-registered socket', async () => {
    const browserA = await connectBrowser(relayUrl, userA, deviceA);
    const closed = new Promise<number>((resolve) =>
      browserA.once('close', (code) => resolve(code)),
    );

    // A registered socket re-hello'ing is never a legitimate client (each opens a fresh socket per
    // connect) — the relay closes it rather than silently rebinding its identity.
    browserA.send(
      JSON.stringify(
        makeEnvelope({
          type: 'hello',
          userId: userA,
          deviceId: deviceA,
          payload: { role: 'browser' },
        }),
      ),
    );
    expect(await closed).toBe(4001);
  });

  it('never replays another channel’s cached session out of the shared ciphertext cache', async () => {
    // B's daemon caches a session.key for B's session (a browser-replayable frame).
    const daemonB = await connectDaemon(relayUrl, userB, deviceB);
    const browserB = await connectBrowser(relayUrl, userB, deviceB);
    const keyToB = waitForEnvelope(browserB, (e) => e.type === 'session.key');
    daemonB.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.key',
          userId: userB,
          deviceId: deviceB,
          sessionId: victimSession,
          payload: 'sealed-key-blob',
          nonce: 'AAAAAAAAAAAAAAAA',
        }),
      ),
    );
    await keyToB; // the frame is now cached under B's channel

    // A's browser subscribes to B's session id (a guessed UUID) on ITS OWN channel — the replay must
    // NOT hand over B's cached ciphertext, even though the session id is valid.
    const browserA = await connectBrowser(relayUrl, userA, deviceA);
    const leaked = waitForEnvelope(browserA, (e) => e.type === 'session.key', 500).then(
      () => 'leaked',
      () => 'scoped-out',
    );
    browserA.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.subscribe',
          userId: userA,
          deviceId: deviceA,
          sessionId: victimSession,
          payload: {},
        }),
      ),
    );
    expect(await leaked).toBe('scoped-out');

    daemonB.close();
    browserB.close();
    browserA.close();
  });

  it('drops a browser frame claiming a different device than its channel', async () => {
    const browserA = await connectBrowser(relayUrl, userA, deviceA);
    const daemonB = await connectDaemon(relayUrl, userB, deviceB);

    // A frame for B's daemon sent down A's channel must never arrive (drop + warn, not a re-route).
    const before = relayLogs.length;
    browserA.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.subscribe',
          userId: userB,
          deviceId: deviceB,
          sessionId: victimSession,
          payload: {},
        }),
      ),
    );
    await vi.waitUntil(
      () =>
        relayLogs.slice(before).some((l) => l.includes('does not match the authenticated peer')),
      { timeout: 3000 },
    );

    // B's daemon received nothing: its next frame is the echo it sends itself, not a subscribe.
    const echoBack = waitForEnvelope(daemonB, (e) => e.type === 'session.subscribe', 500).then(
      () => 'delivered',
      () => 'not-delivered',
    );
    expect(await echoBack).toBe('not-delivered');

    browserA.close();
    daemonB.close();
  });
});
