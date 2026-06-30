import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Adopted sessions (Journey 1, Task 3): the daemon discovers a Claude Code session the user started
 * themselves and announces it with `session.adopted` (no id yet). The relay mints an `origin='external'`
 * registry row, ACKs the daemon with the minted id (so it can pair its hook events), and broadcasts the
 * adopted session to the watching browsers. Daemon-initiated registration — the mirror image of a
 * browser `session.launch`. Real relay, real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('adopted sessions: daemon-initiated registration', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;
  const relayLogs: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    await admin.query('truncate table users restart identity cascade');
    const userRow = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'adopt') returning id",
    );
    userId = userRow.rows[0]!.id;
    const deviceRow = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'laptop', 'h') returning id",
      [userId],
    );
    deviceId = deviceRow.rows[0]!.id;

    const relayLogger = pino(
      { level: 'info' },
      { write: (chunk: string) => relayLogs.push(chunk) },
    );
    app = await buildRelay({ logger: relayLogger, sessionRegistry: createSessionRegistry(handle) });
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

  it('mints an external row, acks the daemon, and broadcasts to the browser', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    const onBrowser = waitForEnvelope(browser, (e) => e.type === 'session.adopted');
    const onDaemonAck = waitForEnvelope(
      daemon,
      (e) => e.type === 'session.adopted' && e.session_id !== undefined,
    );

    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.adopted',
          userId,
          deviceId,
          payload: { clientRef: 'claude-xyz', title: 'fix the bug', cwd: '/Users/me/repo' },
        }),
      ),
    );

    const browserFrame = await onBrowser;
    const daemonAck = await onDaemonAck;

    const sessionId = browserFrame.session_id;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // The daemon's ack carries the SAME minted id + its own clientRef, so it can pair hook events to it.
    expect(daemonAck.session_id).toBe(sessionId);
    expect((daemonAck.payload as { clientRef: string }).clientRef).toBe('claude-xyz');

    // The row is persisted as external + running (an adopted session is already underway).
    const row = await admin.query<{ origin: string; status: string; title: string; cwd: string }>(
      'select origin, status, title, cwd from sessions where id = $1',
      [sessionId],
    );
    expect(row.rows[0]).toMatchObject({
      origin: 'external',
      status: 'running',
      title: 'fix the bug',
      cwd: '/Users/me/repo',
    });

    expect(relayLogs.some((l) => l.includes(sessionId!) && l.includes('session adopted'))).toBe(
      true,
    );

    daemon.close();
    browser.close();
  });

  it('drops a session.adopted with an invalid payload (no clientRef)', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const before = relayLogs.length;
    daemon.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.adopted', userId, deviceId, payload: { title: 'x' } }),
      ),
    );
    // Deterministic barrier: wait for the relay's validation-failure log, not a wall-clock delay.
    await vi.waitUntil(() => relayLogs.slice(before).some((l) => l.includes('invalid payload')), {
      timeout: 2000,
    });
    const count = await admin.query<{ n: string }>('select count(*)::text as n from sessions');
    expect(count.rows[0]!.n).toBe('0');
    daemon.close();
  });
});
