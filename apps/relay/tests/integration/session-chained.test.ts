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
 * Free-form handover continuation registration (Journey 4): the user took over an adopted session's
 * free-form question, so the daemon launches a telecode-owned continuation that resumes the conversation
 * and announces it with `session.chained` (no id yet). The relay mints an `origin='launched'` row linked to
 * the adopted parent via `parent_session_id`, ACKs the daemon with the minted id, and broadcasts it to the
 * watching browsers — the mirror image of `session.adopted`, but launched. Real relay, real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('handover continuation: daemon-initiated chained registration', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;
  let registry: ReturnType<typeof createSessionRegistry>;
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
      "insert into users (provider, provider_user_id) values ('dev', 'chained') returning id",
    );
    userId = userRow.rows[0]!.id;
    const deviceRow = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'laptop', 'h') returning id",
      [userId],
    );
    deviceId = deviceRow.rows[0]!.id;

    registry = createSessionRegistry(handle);
    const relayLogger = pino({ level: 'info' }, { write: (chunk: string) => relayLogs.push(chunk) });
    app = await buildRelay({ logger: relayLogger, sessionRegistry: registry });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table sessions cascade');
  });

  it('mints a launched row linked to the parent, acks the daemon, and broadcasts to the browser', async () => {
    // The adopted parent the continuation resumes from.
    const parentId = await registry.createSession({ userId, deviceId, origin: 'external', title: 'adopted' });

    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    const onBrowser = waitForEnvelope(browser, (e) => e.type === 'session.chained');
    const onDaemonAck = waitForEnvelope(
      daemon,
      (e) => e.type === 'session.chained' && e.session_id !== undefined,
    );

    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.chained',
          userId,
          deviceId,
          payload: {
            clientRef: 'fork-abc',
            parentSessionId: parentId,
            title: 'Continue: which database?',
            cwd: '/Users/me/repo',
          },
        }),
      ),
    );

    const browserFrame = await onBrowser;
    const daemonAck = await onDaemonAck;

    const childId = browserFrame.session_id;
    expect(childId).toMatch(/^[0-9a-f-]{36}$/);
    expect(childId).not.toBe(parentId);
    // The daemon's ack carries the SAME minted id + its own clientRef, so it can drive the child's turns.
    expect(daemonAck.session_id).toBe(childId);
    expect((daemonAck.payload as { clientRef: string }).clientRef).toBe('fork-abc');
    expect((browserFrame.payload as { parentSessionId: string }).parentSessionId).toBe(parentId);

    // The row is persisted as a launched continuation linked to the adopted parent.
    const row = await admin.query<{ origin: string; parent_session_id: string; title: string; cwd: string }>(
      'select origin, parent_session_id, title, cwd from sessions where id = $1',
      [childId],
    );
    expect(row.rows[0]).toMatchObject({
      origin: 'launched',
      parent_session_id: parentId,
      title: 'Continue: which database?',
      cwd: '/Users/me/repo',
    });

    expect(relayLogs.some((l) => l.includes(childId!) && l.includes('session chained'))).toBe(true);

    daemon.close();
    browser.close();
  });

  it('drops a session.chained with an invalid payload (no parentSessionId)', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const before = relayLogs.length;
    daemon.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.chained', userId, deviceId, payload: { clientRef: 'x' } }),
      ),
    );
    await vi.waitUntil(() => relayLogs.slice(before).some((l) => l.includes('invalid payload')), {
      timeout: 2000,
    });
    const count = await admin.query<{ n: string }>('select count(*)::text as n from sessions');
    expect(count.rows[0]!.n).toBe('0');
    daemon.close();
  });

  it('surfaces parent_session_id on GET /me/sessions so the dashboard can link parent ↔ child', async () => {
    const parentId = await registry.createSession({ userId, deviceId, origin: 'external' });
    const childId = await registry.createSession({
      userId,
      deviceId,
      origin: 'launched',
      parentSessionId: parentId,
    });
    const list = await registry.listByUser(userId);
    const child = list.find((s) => s.id === childId);
    const parent = list.find((s) => s.id === parentId);
    expect(child?.parentSessionId).toBe(parentId);
    expect(parent?.parentSessionId).toBeNull();
  });
});
