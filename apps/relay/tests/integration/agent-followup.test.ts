import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { expectSessionStatus } from '../_helpers/db';
import { connectBrowser } from '../_helpers/ws';

/**
 * Task 8 — `user.message` follow-ups. After the first turn ends, the browser sends a follow-up; the
 * daemon resumes the *same* agent conversation (threading the SDK `resume` id) and streams another turn.
 * Real relay + real Postgres + in-process daemon (fake adapter records the prompt + resume per turn).
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SDK_SESSION_ID = 'sdk-conversation-1';

describe('follow-ups: launch → turn → user.message → resumed turn', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;
  const runs: { prompt: string; resume?: string }[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    await admin.query('truncate table users restart identity cascade');
    const u = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'followup') returning id",
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
      agentAdapter: createFakeAgentAdapter([{ type: 'message', text: 'Working' }], {
        sessionId: SDK_SESSION_ID,
        onRun: (call) => runs.push(call),
      }),
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
    runs.length = 0;
  });

  it('resumes the agent conversation on a follow-up and streams a second turn', async () => {
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const received: Envelope[] = [];
    let endedCount = 0;
    let resolveTurn1: () => void;
    let resolveTurn2: () => void;
    const turn1 = new Promise<void>((resolve) => (resolveTurn1 = resolve));
    const turn2 = new Promise<void>((resolve) => (resolveTurn2 = resolve));

    browser.on('message', (raw: Buffer) => {
      const envelope = parseEnvelope(JSON.parse(raw.toString()));
      received.push(envelope);
      if (envelope.type === 'session.ended') {
        endedCount += 1;
        if (endedCount === 1) resolveTurn1();
        else resolveTurn2();
      }
    });

    browser.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.launch', userId, deviceId, payload: { prompt: 'do it' } }),
      ),
    );
    await turn1;

    const sessionId = received[0]?.session_id;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    if (sessionId === undefined) throw new Error('no session id');

    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'user.message',
          userId,
          deviceId,
          sessionId,
          payload: { text: 'now do more' },
        }),
      ),
    );
    await turn2;

    // Two turns streamed; the follow-up resumed the first turn's conversation id.
    expect(received.map((e) => e.type)).toEqual([
      'session.started',
      'session.meta',
      'agent.message',
      'session.ended',
      'agent.message',
      'session.ended',
    ]);
    expect(runs).toEqual([{ prompt: 'do it' }, { prompt: 'now do more', resume: SDK_SESSION_ID }]);

    await expectSessionStatus(admin, sessionId, 'done');

    browser.close();
  });

  it('drops a follow-up for an unknown session (no conversation to resume)', async () => {
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const seen: string[] = [];
    browser.on('message', (raw: Buffer) => {
      seen.push(parseEnvelope(JSON.parse(raw.toString())).type);
    });

    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'user.message',
          userId,
          deviceId,
          sessionId: '00000000-0000-0000-0000-000000000000',
          payload: { text: 'orphan follow-up' },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The daemon has no conversation for this session id, so it streams nothing back.
    expect(seen).not.toContain('session.started');
    expect(seen).not.toContain('session.ended');
    expect(runs).toEqual([]);
    browser.close();
  });
});
