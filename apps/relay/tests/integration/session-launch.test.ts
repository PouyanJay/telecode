import type { AddressInfo } from 'node:net';

import { createDaemon, type Daemon } from '@telecode/daemon';
import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, waitForEnvelope } from '../_helpers/ws';

/**
 * Phase 1 walking skeleton: a browser launches a session → the relay persists a registry row (RLS-scoped)
 * and routes the launch to the in-process daemon → the daemon replies `session.started` → the relay flips
 * the row to `running` and forwards it back to the browser. Real relay, real Postgres, real daemon
 * transport; only the agent itself is trivial (no model call yet).
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('walking skeleton: persisted session launch', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;
  const relayLogs: string[] = [];
  const daemonLogs: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    // Seed a real user + device via the trusted (superuser) path; auth + pairing land in Tasks 3–4.
    await admin.query('truncate table users restart identity cascade');
    const u = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'launch') returning id",
    );
    userId = u.rows[0]!.id;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'laptop', 'h') returning id",
      [userId],
    );
    deviceId = d.rows[0]!.id;

    const relayLogger = pino(
      { level: 'info' },
      { write: (chunk: string) => relayLogs.push(chunk) },
    );
    app = await buildRelay({ logger: relayLogger, sessionRegistry: createSessionRegistry(handle) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    const daemonLogger = pino(
      { level: 'info' },
      { write: (chunk: string) => daemonLogs.push(chunk) },
    );
    daemon = createDaemon({ relayUrl, userId, deviceId, logger: daemonLogger });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon?.stop();
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table sessions');
  });

  it('persists the session and round-trips session.started to the browser', async () => {
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const started = waitForEnvelope(browser, (e) => e.type === 'session.started');

    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.launch',
          userId,
          deviceId,
          payload: { prompt: 'hello world' },
        }),
      ),
    );

    const envelope = await started;
    const sessionId = envelope.session_id;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Behavioral check: the row really exists and is running (queried out-of-band as superuser).
    const row = await admin.query<{ user_id: string; device_id: string; status: string }>(
      'select user_id, device_id, status from sessions where id = $1',
      [sessionId],
    );
    expect(row.rows[0]).toMatchObject({ user_id: userId, device_id: deviceId, status: 'running' });

    // Correlation: the session_id threads through both the daemon and relay logs.
    expect(
      daemonLogs.some((l) => l.includes(sessionId!) && l.includes('session launch received')),
    ).toBe(true);
    expect(relayLogs.some((l) => l.includes(sessionId!) && l.includes('session running'))).toBe(
      true,
    );

    browser.close();
  });
});
