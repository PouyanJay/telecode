import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry, type SessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { expectSessionStatus } from '../_helpers/db';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Session reconciliation: on every (re)connect the daemon sends `session.reconcile` with the ids it still
 * holds. The relay retires (marks `needs_restart`) any OTHER non-terminal session for that device left stale in the
 * registry — the phantom "awaiting"/"running" rows a revoke/restart leaves behind — and tells watching
 * browsers, so a live dashboard clears without a refresh. Real relay + real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('relay: session reconciliation retires stale rows on daemon (re)connect', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let registry: SessionRegistry;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;
  let otherDeviceId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    await admin.query('truncate table users restart identity cascade');
    const u = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'reconcile') returning id",
    );
    userId = u.rows[0]!.id;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'lap', 'h1') returning id",
      [userId],
    );
    deviceId = d.rows[0]!.id;
    const d2 = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'other', 'h2') returning id",
      [userId],
    );
    otherDeviceId = d2.rows[0]!.id;

    registry = createSessionRegistry(handle);
    app = await buildRelay({ logger: pino({ level: 'silent' }), sessionRegistry: registry });
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

  it('retires non-held awaiting/running rows, keeps held + terminal, and never touches another device', async () => {
    // Seed the registry: a held-running one, a stale-awaiting one, an already-done one — all on `deviceId` —
    // plus an awaiting one on a DIFFERENT device (must be untouched: reconcile is per-device).
    const held = await registry.createSession({ userId, deviceId });
    await registry.markRunning({ userId, sessionId: held });
    const staleAwaiting = await registry.createSession({ userId, deviceId });
    await registry.markAwaitingInput({ userId, sessionId: staleAwaiting });
    const alreadyDone = await registry.createSession({ userId, deviceId });
    await registry.markEnded({ userId, sessionId: alreadyDone, status: 'done' });
    const otherDeviceAwaiting = await registry.createSession({ userId, deviceId: otherDeviceId });
    await registry.markAwaitingInput({ userId, sessionId: otherDeviceAwaiting });
    // A launch not yet accepted stays `starting`: reconcile must NOT retire it — it may be a launch just
    // forwarded to the daemon (a genuinely orphaned one is failed by the offline-launch path instead).
    const orphanStarting = await registry.createSession({ userId, deviceId });

    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    // The daemon reports it holds only `held`. The relay must retire `staleAwaiting` (non-held, non-terminal).
    const retired = waitForEnvelope(
      browser,
      (e) => e.type === 'session.ended' && e.session_id === staleAwaiting,
    );
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.reconcile',
          userId,
          deviceId,
          payload: { heldSessionIds: [held] },
        }),
      ),
    );
    // The browser is told the stale session ended — the barrier proving reconcile ran. The synthetic
    // frame carries the honest terminal state: the daemon LOST this conversation (status split, T2).
    const retiredFrame = await retired;
    expect(retiredFrame.status).toBe('needs_restart');

    // The stale awaiting row is now needs_restart; the held and already-done rows are unchanged; the
    // other device's session is untouched.
    await expectSessionStatus(admin, staleAwaiting, 'needs_restart');
    await expectSessionStatus(admin, held, 'running');
    await expectSessionStatus(admin, alreadyDone, 'done');
    await expectSessionStatus(admin, otherDeviceAwaiting, 'awaiting_input');
    await expectSessionStatus(admin, orphanStarting, 'starting');

    daemon.close();
    browser.close();
  });

  it('retires everything non-terminal for the device when the daemon holds nothing (cold restart)', async () => {
    const awaiting = await registry.createSession({ userId, deviceId });
    await registry.markAwaitingInput({ userId, sessionId: awaiting });
    const running = await registry.createSession({ userId, deviceId });
    await registry.markRunning({ userId, sessionId: running });

    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    // Wait for BOTH retirements (not just one) so the DB assertions don't lean on the status poll's tolerance.
    const endedAwaiting = waitForEnvelope(
      browser,
      (e) => e.type === 'session.ended' && e.session_id === awaiting,
    );
    const endedRunning = waitForEnvelope(
      browser,
      (e) => e.type === 'session.ended' && e.session_id === running,
    );
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.reconcile',
          userId,
          deviceId,
          payload: { heldSessionIds: [] },
        }),
      ),
    );
    await Promise.all([endedAwaiting, endedRunning]);

    await expectSessionStatus(admin, awaiting, 'needs_restart');
    await expectSessionStatus(admin, running, 'needs_restart');

    daemon.close();
    browser.close();
  });
});
