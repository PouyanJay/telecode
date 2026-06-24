import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import {
  agentMessagePayloadSchema,
  agentToolUsePayloadSchema,
  makeEnvelope,
  parseEnvelope,
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
import { connectBrowser } from '../_helpers/ws';

/**
 * Task 5: launching a session runs the (fake) agent adapter on the daemon and streams its activity up
 * to the browser — `session.started` → `agent.message` / `agent.tool_use` (in order) → `session.ended`
 * — and the relay flips the session row to `done`. Real relay + real Postgres + in-process daemon.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('agent streaming: launch → streamed messages/tool calls → ended', () => {
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
      "insert into users (provider, provider_user_id) values ('dev', 'stream') returning id",
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

    // The daemon runs a deterministic scripted agent — no model call.
    daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      logger: pino({ level: 'silent' }),
      agentAdapter: createFakeAgentAdapter([
        { type: 'message', text: 'Working on it' },
        { type: 'tool_use', toolName: 'Read', input: { path: 'README.md' } },
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

  it('streams the agent run to the browser and ends the session', async () => {
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    const received: Envelope[] = [];
    const ended = new Promise<void>((resolve, reject) => {
      browser.on('message', (raw: Buffer) => {
        const envelope = parseEnvelope(JSON.parse(raw.toString()));
        received.push(envelope);
        if (envelope.type === 'session.ended') resolve();
      });
      setTimeout(() => reject(new Error('timed out before session.ended')), 5000);
    });

    browser.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.launch', userId, deviceId, payload: { prompt: 'do it' } }),
      ),
    );
    await ended;

    expect(received.map((e) => e.type)).toEqual([
      'session.started',
      'agent.message',
      'agent.tool_use',
      'agent.message',
      'session.ended',
    ]);

    const messages = received
      .filter((e) => e.type === 'agent.message')
      .map((e) => agentMessagePayloadSchema.parse(e.payload).text);
    expect(messages).toEqual(['Working on it', 'All done']);

    const toolUse = received.find((e) => e.type === 'agent.tool_use');
    expect(agentToolUsePayloadSchema.parse(toolUse?.payload)).toMatchObject({ toolName: 'Read' });

    // Every streamed frame carried the same session id, and the row is now `done`.
    const sessionId = received[0]?.session_id;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const row = await admin.query<{ status: string }>('select status from sessions where id = $1', [
      sessionId,
    ]);
    expect(row.rows[0]?.status).toBe('done');

    browser.close();
  });
});
