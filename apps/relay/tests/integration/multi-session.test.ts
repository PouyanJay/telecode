import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import {
  agentPermissionRequestPayloadSchema,
  makeEnvelope,
  parseEnvelope,
  type Envelope,
} from '@telecode/protocol';
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
 * Phase 2 walking skeleton: one device runs *two* sessions at once. Each fake agent run blocks at a
 * tool gate, so both sessions are alive (awaiting_input) simultaneously — proving the daemon holds
 * per-session state concurrently and the relay routes per session_id. The registry then enumerates
 * both for the user (`listByUser`), the data path the dashboard + reconnect build on. Real relay +
 * real Postgres + in-process daemon; no model call.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('walking skeleton: two concurrent sessions on one device, enumerated', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let handle: DbHandle;
  let admin: Pool;
  let registry: SessionRegistry;
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

    await admin.query('truncate table users restart identity cascade');
    const u = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'multi') returning id",
    );
    userId = u.rows[0]!.id;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'lap', 'h') returning id",
      [userId],
    );
    deviceId = d.rows[0]!.id;

    registry = createSessionRegistry(handle);
    const relayLogger = pino(
      { level: 'info' },
      { write: (chunk: string) => relayLogs.push(chunk) },
    );
    app = await buildRelay({ logger: relayLogger, sessionRegistry: registry });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    // Each run blocks at a tool gate (never auto-approved here), parking the session at awaiting_input.
    const daemonLogger = pino(
      { level: 'info' },
      { write: (chunk: string) => daemonLogs.push(chunk) },
    );
    daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      logger: daemonLogger,
      agentAdapter: createFakeAgentAdapter([
        { type: 'tool_use', toolName: 'Read', input: { path: 'README.md' } },
      ]),
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

  it('keeps two sessions alive at once and enumerates them for the user', async () => {
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    const startedIds = new Set<string>();
    const endedIds = new Set<string>();
    // Each live session's pending gate, so we can release exactly the right requestId per session.
    const pendingBySession = new Map<string, string>();
    browser.on('message', (raw: Buffer) => {
      const e: Envelope = parseEnvelope(JSON.parse(raw.toString()));
      if (e.session_id === undefined) return;
      if (e.type === 'session.started') startedIds.add(e.session_id);
      if (e.type === 'session.ended') endedIds.add(e.session_id);
      if (e.type === 'agent.permission_request') {
        const req = agentPermissionRequestPayloadSchema.parse(e.payload);
        pendingBySession.set(e.session_id, req.requestId);
      }
    });

    // Launch two sessions back-to-back; neither is approved, so both park at the gate.
    for (const prompt of ['alpha', 'beta']) {
      browser.send(
        JSON.stringify(
          makeEnvelope({ type: 'session.launch', userId, deviceId, payload: { prompt } }),
        ),
      );
    }

    // Both sessions reach the gate => both are live concurrently.
    await vi.waitFor(() => expect(pendingBySession.size).toBe(2), { timeout: 5000 });
    const ids = [...pendingBySession.keys()].sort();
    // Per-session routing: the two `session.started` ids are exactly the two gated sessions (uncrossed).
    expect([...startedIds].sort()).toEqual(ids);

    // The registry enumerates exactly these two, both awaiting_input, for this user/device.
    const list = await registry.listByUser(userId);
    expect(list.map((s) => s.id).sort()).toEqual(ids);
    expect(list.every((s) => s.status === 'awaiting_input')).toBe(true);
    expect(list.every((s) => s.deviceId === deviceId)).toBe(true);

    // Correlation: each distinct session id threads independently through the daemon + relay logs.
    for (const id of ids) {
      expect(daemonLogs.some((l) => l.includes(id) && l.includes('session launch received'))).toBe(
        true,
      );
      expect(relayLogs.some((l) => l.includes(id) && l.includes('session running'))).toBe(true);
    }

    // Release both gates and let both runs finish before teardown (no in-flight runs at close).
    for (const [sessionId, requestId] of pendingBySession) {
      browser.send(
        JSON.stringify(
          makeEnvelope({
            type: 'permission.decision',
            userId,
            deviceId,
            sessionId,
            payload: { requestId, behavior: 'allow' },
          }),
        ),
      );
    }
    await vi.waitFor(() => expect(endedIds).toEqual(new Set(ids)), { timeout: 5000 });

    browser.close();
  });
});
