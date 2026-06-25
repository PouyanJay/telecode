import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry, type SessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser } from '../_helpers/ws';

/**
 * Phase 2 Task 9b — a paused session must survive a UI reload, so the daemon's `session.status` report
 * is persisted to the registry (the dashboard/reconnect source). Full loop: browser → relay → daemon →
 * `session.status{paused}` → relay persists. Real relay + Postgres + in-process daemon; no model call.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('relay persists a daemon session.status report (pause/resume)', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let handle: DbHandle;
  let admin: Pool;
  let registry: SessionRegistry;
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
      "insert into users (provider, provider_user_id) values ('dev', 'ctrl') returning id",
    );
    userId = u.rows[0]!.id;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'lap', 'h') returning id",
      [userId],
    );
    deviceId = d.rows[0]!.id;

    registry = createSessionRegistry(handle);
    app = await buildRelay({ logger: pino({ level: 'silent' }), sessionRegistry: registry });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    // A run that completes immediately, so the session reaches `done` (idle) and we can pause it.
    daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      logger: pino({ level: 'silent' }),
      agentAdapter: createFakeAgentAdapter([{ type: 'message', text: 'hi' }]),
    });
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

  it('persists paused on pause and restores the prior status on resume', async () => {
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    let sessionId: string | undefined;
    const statuses: string[] = [];
    browser.on('message', (raw: Buffer) => {
      const e: Envelope = parseEnvelope(JSON.parse(raw.toString()));
      if (e.type === 'session.started' && e.session_id) sessionId = e.session_id;
      if (e.type === 'session.status') statuses.push((e.payload as { status: string }).status);
    });

    const send = (
      type: 'session.launch' | 'session.control',
      payload: unknown,
      id?: string,
    ): void =>
      browser.send(
        JSON.stringify(
          makeEnvelope({ type, userId, deviceId, ...(id ? { sessionId: id } : {}), payload }),
        ),
      );

    send('session.launch', { prompt: 'do it' });
    await vi.waitFor(() => expect(sessionId).toBeDefined(), { timeout: 5000 });
    const id = sessionId as string;
    // The turn completes → the row is `done` (terminal) before we pause it.
    await vi.waitFor(async () => {
      const [row] = await registry.listByUser(userId);
      expect(row?.status).toBe('done');
    });

    // Pause → the daemon reports `paused`; the relay persists it (so a reload would still show paused).
    send('session.control', { action: 'pause' }, id);
    await vi.waitFor(async () => {
      const [row] = await registry.listByUser(userId);
      expect(row?.status).toBe('paused');
    });
    expect(statuses).toContain('paused');

    // Resume → the prior status (`done`) is restored and persisted.
    send('session.control', { action: 'resume' }, id);
    await vi.waitFor(async () => {
      const [row] = await registry.listByUser(userId);
      expect(row?.status).toBe('done');
    });

    browser.close();
  });
});
