import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { expectSessionStatus } from '../_helpers/db';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Phase 3 Task 4: under E2E the relay can no longer read `status` from the (now-ciphertext) payload of
 * `session.ended` / `session.status`, so it reads the cleartext `status` envelope field instead. This
 * test sends those lifecycle messages with the status in the envelope field and an OPAQUE payload the
 * relay cannot parse, and asserts the Postgres session registry still transitions correctly — proving the
 * relay derives status from routing metadata, never from the payload. Real relay + real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('relay reads session status from the cleartext envelope field (E2E)', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    await admin.query('truncate table users restart identity cascade');
    const u = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'e2e-status') returning id",
    );
    userId = u.rows[0]!.id;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'lap', 'h') returning id",
      [userId],
    );
    deviceId = d.rows[0]!.id;

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
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

  beforeEach(async () => {
    await admin.query('truncate table sessions');
  });

  /** Launch a session through the real path and return the relay-minted id the daemon receives. */
  async function launchSession(
    daemon: import('ws').WebSocket,
    browser: import('ws').WebSocket,
  ): Promise<string> {
    const onDaemon = waitForEnvelope(daemon, (e) => e.type === 'session.launch');
    // The launch payload is opaque to the relay (ciphertext under E2E) — it mints the id from metadata.
    browser.send(
      JSON.stringify(makeEnvelope({ type: 'session.launch', userId, deviceId, payload: 'OPAQUE' })),
    );
    const launch = await onDaemon;
    if (!launch.session_id) throw new Error('relay did not mint a session id');
    return launch.session_id;
  }

  it('marks ended with the envelope status (error) when the payload is opaque ciphertext', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await launchSession(daemon, browser);

    // session.ended now reaches the browser before the relay persists the status (so DONE/ERROR isn't gated
    // on a DB round-trip), so the persisted status is asserted with a short poll.
    const ended = waitForEnvelope(browser, (e) => e.type === 'session.ended');
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.ended',
          userId,
          deviceId,
          sessionId,
          status: 'error',
          payload: 'b64-ciphertext-the-relay-cannot-parse',
        }),
      ),
    );
    await ended;

    // If the relay had parsed the payload it would have fallen back to 'done'; 'error' proves it read the field.
    await expectSessionStatus(admin, sessionId, 'error');

    daemon.close();
    browser.close();
  });

  it('marks ended with the envelope status turn_limit (status split, ux Phase 6 T2)', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await launchSession(daemon, browser);

    const ended = waitForEnvelope(browser, (e) => e.type === 'session.ended');
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.ended',
          userId,
          deviceId,
          sessionId,
          status: 'turn_limit',
          payload: 'b64-ciphertext-the-relay-cannot-parse',
        }),
      ),
    );
    await ended;

    await expectSessionStatus(admin, sessionId, 'turn_limit');

    daemon.close();
    browser.close();
  });

  it('persists waiting_local from a session.status frame and forwards it (adopted-takeover T1)', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await launchSession(daemon, browser);

    // An adopted session's turn ended: the daemon reports the between-turns truth. Payload is opaque
    // ciphertext — the relay must read the cleartext envelope status, persist it, then forward.
    const statusSeen = waitForEnvelope(browser, (e) => e.type === 'session.status');
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.status',
          userId,
          deviceId,
          sessionId,
          status: 'waiting_local',
          payload: 'b64-ciphertext-the-relay-cannot-parse',
        }),
      ),
    );
    await statusSeen;
    await expectSessionStatus(admin, sessionId, 'waiting_local');

    // And the mirror move: a new local turn began — the same frame type flips the row back to running.
    const runningSeen = waitForEnvelope(
      browser,
      (e) => e.type === 'session.status' && e.status === 'running',
    );
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.status',
          userId,
          deviceId,
          sessionId,
          status: 'running',
          payload: 'b64-ciphertext-the-relay-cannot-parse',
        }),
      ),
    );
    await runningSeen;
    await expectSessionStatus(admin, sessionId, 'running');

    daemon.close();
    browser.close();
  });

  it('drops a session.status frame whose status is not a reportable one (endings have session.ended)', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await launchSession(daemon, browser);

    // 'error' must never ride session.status (that's session.ended's job) — the frame is dropped
    // whole: not persisted, not forwarded. Proven by the next frame arriving instead of it.
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.status',
          userId,
          deviceId,
          sessionId,
          status: 'error',
          payload: 'b64-ciphertext-the-relay-cannot-parse',
        }),
      ),
    );
    const probe = waitForEnvelope(browser, (e) => e.type === 'session.status');
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.status',
          userId,
          deviceId,
          sessionId,
          status: 'waiting_local',
          payload: 'b64-ciphertext-the-relay-cannot-parse',
        }),
      ),
    );
    const first = await probe;
    expect(first.status).toBe('waiting_local');
    await expectSessionStatus(admin, sessionId, 'waiting_local');

    daemon.close();
    browser.close();
  });

  it('falls back to the PAYLOAD status for a cleartext-mode session.status with no envelope field', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await launchSession(daemon, browser);

    const statusSeen = waitForEnvelope(browser, (e) => e.type === 'session.status');
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.status',
          userId,
          deviceId,
          sessionId,
          payload: { status: 'waiting_local' },
        }),
      ),
    );
    await statusSeen;
    await expectSessionStatus(admin, sessionId, 'waiting_local');

    daemon.close();
    browser.close();
  });

  it('falls back to the PAYLOAD status for a cleartext-mode peer with no envelope field', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await launchSession(daemon, browser);

    const ended = waitForEnvelope(browser, (e) => e.type === 'session.ended');
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.ended',
          userId,
          deviceId,
          sessionId,
          payload: { status: 'turn_limit' },
        }),
      ),
    );
    await ended;

    await expectSessionStatus(admin, sessionId, 'turn_limit');

    daemon.close();
    browser.close();
  });
});
