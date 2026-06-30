import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import {
  agentPermissionRequestPayloadSchema,
  makeEnvelope,
  parseEnvelope,
  sessionHistoryPayloadSchema,
  type Envelope,
} from '@telecode/protocol';
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
 * Phase 2 Task 4 — reconnect/backfill. The daemon holds the live transcript; a browser that reopens
 * re-attaches with `session.subscribe` and the daemon replies `session.history` (ordered transcript +
 * status) — so the relay never needs the plaintext (E2E-consistent). Real relay + Postgres + in-process
 * daemon; the agent is a deterministic fake.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('reconnect: session.subscribe → session.history backfill', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
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
      "insert into users (provider, provider_user_id) values ('dev', 'history') returning id",
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

    daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      logger: pino({ level: 'silent' }),
      agentAdapter: createFakeAgentAdapter([
        { type: 'message', text: 'Working on it' },
        // A read-only tool auto-approves (no human gate); a consequential one is gated to the operator.
        { type: 'tool_use', toolName: 'Read', input: { path: 'README.md' } },
        { type: 'tool_use', toolName: 'Bash', input: { command: 'ls' } },
        { type: 'message', text: 'All done' },
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

  it('backfills the full transcript of a finished session to a fresh browser', async () => {
    // Browser A launches and drives the session to completion (auto-approving the tool gate).
    const a = await connectBrowser(relayUrl, userId, deviceId);
    let sessionId: string | undefined;
    const aEnded = new Promise<void>((resolve, reject) => {
      a.on('message', (raw: Buffer) => {
        const e = parseEnvelope(JSON.parse(raw.toString()));
        if (e.type === 'session.started') sessionId = e.session_id;
        if (e.type === 'agent.permission_request' && e.session_id) {
          const req = agentPermissionRequestPayloadSchema.parse(e.payload);
          a.send(
            JSON.stringify(
              makeEnvelope({
                type: 'permission.decision',
                userId,
                deviceId,
                sessionId: e.session_id,
                payload: { requestId: req.requestId, behavior: 'allow' },
              }),
            ),
          );
        }
        if (e.type === 'session.ended') resolve();
      });
      setTimeout(() => reject(new Error('timed out before session.ended')), 5000);
    });

    a.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.launch', userId, deviceId, payload: { prompt: 'do it' } }),
      ),
    );
    await aEnded;
    a.close();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    if (sessionId === undefined) throw new Error('expected a session id from session.started');

    // Browser B reopens fresh and re-attaches — the daemon backfills the whole transcript.
    const b = await connectBrowser(relayUrl, userId, deviceId);
    const history = waitForEnvelope(b, (e) => e.type === 'session.history');
    b.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }),
      ),
    );
    const envelope: Envelope = await history;
    expect(envelope.session_id).toBe(sessionId);

    const payload = sessionHistoryPayloadSchema.parse(envelope.payload);
    expect(payload.status).toBe('done');
    // The full ordered transcript: user prompt, agent text, the auto-approved read (tool only, no gate),
    // then the gated bash (resolved gate + tool), agent text.
    expect(payload.entries).toMatchObject([
      { kind: 'user', text: 'do it' },
      { kind: 'message', text: 'Working on it' },
      { kind: 'tool', toolName: 'Read', input: { path: 'README.md' } },
      { kind: 'permission', toolName: 'Bash', input: { command: 'ls' }, decision: 'allow' },
      { kind: 'tool', toolName: 'Bash', input: { command: 'ls' } },
      { kind: 'message', text: 'All done' },
    ]);
    const gate = payload.entries[3];
    expect(gate?.kind).toBe('permission');
    if (gate?.kind === 'permission') expect(typeof gate.requestId).toBe('string');

    b.close();
  });

  it('reports a not-live session (empty, offline_paused) when the daemon holds no record', async () => {
    const b = await connectBrowser(relayUrl, userId, deviceId);
    const history = waitForEnvelope(b, (e) => e.type === 'session.history');
    b.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.subscribe',
          userId,
          deviceId,
          sessionId: '00000000-0000-0000-0000-000000000000',
          payload: {},
        }),
      ),
    );
    const payload = sessionHistoryPayloadSchema.parse((await history).payload);
    expect(payload.entries).toEqual([]);
    expect(payload.status).toBe('offline_paused');
    b.close();
  });
});
