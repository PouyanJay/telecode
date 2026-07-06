import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Sealed session metadata (ux Phase 6, T1 walking skeleton), relay leg. A daemon `session.meta` frame is
 * an OPAQUE blob to the relay: it must (1) persist the ciphertext + nonce on the session row so a cold
 * page load can decrypt titles client-side, (2) broadcast the frame to watching browsers, (3) replay the
 * LATEST one on `session.subscribe`, and (4) expose the blob via `GET /me/sessions` — all without ever
 * reading the payload. Real relay, real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;

// A stand-in ciphertext blob: to the relay it is just an opaque base64 string + nonce.
const BLOB_1 = 'b2xkZXItY2lwaGVydGV4dA==';
const BLOB_2 = 'bmV3ZXItY2lwaGVydGV4dA==';
const NONCE = 'AAAAAAAAAAAAAAAA';

describe('session.meta: sealed metadata through the relay', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;
  let sessionToken: string;
  let channelToken: string;
  const relayLogs: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    await admin.query('truncate table users restart identity cascade');
    // The auth session mints (or reuses) the user; the registry rows must belong to that same user or
    // the RLS-scoped /me/sessions read returns nothing.
    const auth = createAuthService({ db: handle, channelTokenSecret: 'channel-secret-test' });
    const minted = await auth.createSession({ provider: 'dev', providerUserId: 'meta' });
    sessionToken = minted.token;
    userId = minted.userId;
    // With auth enabled a browser hello must carry a channel token for this user (relay boundary).
    channelToken = await auth.mintChannelToken(userId);
    const deviceRow = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'laptop', 'h') returning id",
      [userId],
    );
    deviceId = deviceRow.rows[0]!.id;

    app = await buildRelay({
      // Captured (not silent): the drop-path test uses the relay's own warn line as its barrier.
      logger: pino({ level: 'info' }, { write: (chunk: string) => relayLogs.push(chunk) }),
      sessionRegistry: createSessionRegistry(handle),
      auth: { service: auth, serviceSecret: 'svc-secret-test' },
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
    await admin.query('truncate table sessions');
  });

  async function mintSession(): Promise<string> {
    const row = await admin.query<{ id: string }>(
      "insert into sessions (user_id, device_id, status) values ($1, $2, 'running') returning id",
      [userId, deviceId],
    );
    return row.rows[0]!.id;
  }

  function metaFrame(sessionId: string, blob: string): string {
    return JSON.stringify(
      makeEnvelope({
        type: 'session.meta',
        userId,
        deviceId,
        sessionId,
        payload: blob,
        nonce: NONCE,
      }),
    );
  }

  it('persists the opaque blob on the row and broadcasts the frame to browsers', async () => {
    const sessionId = await mintSession();
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId, channelToken);

    const onBrowser = waitForEnvelope(browser, (e) => e.type === 'session.meta');
    daemon.send(metaFrame(sessionId, BLOB_1));

    // The browser receives the frame verbatim (ciphertext untouched).
    const frame = await onBrowser;
    expect(frame.session_id).toBe(sessionId);
    expect(frame.payload).toBe(BLOB_1);
    expect(frame.nonce).toBe(NONCE);

    // The blob is persisted for cold loads; a second frame overwrites it (latest wins).
    await vi.waitUntil(
      async () =>
        (
          await admin.query<{ sealed_meta: string | null }>(
            'select sealed_meta from sessions where id = $1',
            [sessionId],
          )
        ).rows[0]?.sealed_meta === BLOB_1,
      { timeout: 3000 },
    );
    daemon.send(metaFrame(sessionId, BLOB_2));
    await vi.waitUntil(
      async () =>
        (
          await admin.query<{ sealed_meta: string | null }>(
            'select sealed_meta from sessions where id = $1',
            [sessionId],
          )
        ).rows[0]?.sealed_meta === BLOB_2,
      { timeout: 3000 },
    );
    const row = await admin.query<{ sealed_meta_nonce: string | null }>(
      'select sealed_meta_nonce from sessions where id = $1',
      [sessionId],
    );
    expect(row.rows[0]?.sealed_meta_nonce).toBe(NONCE);

    daemon.close();
    browser.close();
  });

  it('replays the latest session.meta to a subscribing browser (warm-cache reopen)', async () => {
    const sessionId = await mintSession();
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const early = await connectBrowser(relayUrl, userId, deviceId, channelToken);
    // Barrier on BLOB_2's own broadcast: the relay caches a frame before broadcasting it, so seeing
    // BLOB_2 here guarantees the cache already holds the latest blob when the late browser subscribes.
    const seen = waitForEnvelope(early, (e) => e.type === 'session.meta' && e.payload === BLOB_2);
    daemon.send(metaFrame(sessionId, BLOB_1));
    daemon.send(metaFrame(sessionId, BLOB_2));
    await seen;
    early.close();

    // A browser that reopens later subscribes; the relay replays the LATEST blob only.
    const late = await connectBrowser(relayUrl, userId, deviceId, channelToken);
    const replayed = waitForEnvelope(late, (e) => e.type === 'session.meta');
    late.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }),
      ),
    );
    const frame = await replayed;
    expect(frame.payload).toBe(BLOB_2);

    daemon.close();
    late.close();
  });

  it('drops malformed cleartext and oversized ciphertext session.meta (never stored, never forwarded)', async () => {
    const sessionId = await mintSession();
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId, channelToken);

    // Seed a valid blob so the drops below have something they must NOT overwrite.
    const seeded = waitForEnvelope(browser, (e) => e.type === 'session.meta');
    daemon.send(metaFrame(sessionId, BLOB_1));
    await seeded;

    // 1. Cleartext mode (empty nonce) must pass the same schema gate as adopted/chained announces.
    const dropsBefore = relayLogs.length;
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.meta',
          userId,
          deviceId,
          sessionId,
          payload: { title: 42 },
        }),
      ),
    );
    // 2. Ciphertext mode is opaque, but its SIZE is still bounded.
    daemon.send(metaFrame(sessionId, 'A'.repeat(8193)));
    await vi.waitUntil(
      () =>
        relayLogs.slice(dropsBefore).filter((l) => l.includes('dropped session.meta')).length >= 2,
      { timeout: 3000 },
    );

    // Neither drop reached the row; a following valid frame is the next thing the browser sees.
    const next = waitForEnvelope(browser, (e) => e.type === 'session.meta');
    daemon.send(metaFrame(sessionId, BLOB_2));
    expect((await next).payload).toBe(BLOB_2);
    const row = await admin.query<{ sealed_meta: string | null }>(
      'select sealed_meta from sessions where id = $1',
      [sessionId],
    );
    expect(row.rows[0]?.sealed_meta).toBe(BLOB_2);

    daemon.close();
    browser.close();
  });

  it('returns the sealed blob from GET /me/sessions (cold-load source)', async () => {
    const sessionId = await mintSession();
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId, channelToken);
    const seen = waitForEnvelope(browser, (e) => e.type === 'session.meta');
    daemon.send(metaFrame(sessionId, BLOB_1));
    await seen;

    await vi.waitUntil(
      async () =>
        (
          await admin.query<{ sealed_meta: string | null }>(
            'select sealed_meta from sessions where id = $1',
            [sessionId],
          )
        ).rows[0]?.sealed_meta === BLOB_1,
      { timeout: 3000 },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/me/sessions',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      sessions: { id: string; sealed_meta: string | null; sealed_meta_nonce: string | null }[];
    }>();
    const session = body.sessions.find((s) => s.id === sessionId);
    expect(session?.sealed_meta).toBe(BLOB_1);
    expect(session?.sealed_meta_nonce).toBe(NONCE);

    daemon.close();
    browser.close();
  });
});
