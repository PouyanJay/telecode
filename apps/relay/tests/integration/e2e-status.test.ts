import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

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
});
