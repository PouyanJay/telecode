import type { AddressInfo } from 'node:net';

import { makeEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Adopted-session questions through the relay (Journey 2, Task 4). The daemon forwards an `agent.question`
 * (an adopted `AskUserQuestion`) and the relay must, exactly as for `agent.permission_request`: persist the
 * session as `awaiting_input`, broadcast it to the browsers, and cache it for an instant reopen. The browser
 * replies with `question.answer`, which the relay flips back to `running` and forwards opaquely to the daemon.
 * The relay stays payload-blind throughout (correct under E2E ciphertext). Real relay, real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const QUESTION_PAYLOAD = {
  requestId: 'q1',
  questions: [
    {
      question: 'Which database should we use?',
      header: 'Database',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    },
  ],
};

describe('adopted sessions: question routing', () => {
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
    const userRow = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'question') returning id",
    );
    userId = userRow.rows[0]!.id;
    const deviceRow = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'laptop', 'h') returning id",
      [userId],
    );
    deviceId = deviceRow.rows[0]!.id;

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

  /** Adopt an external session and return the relay-minted id (the daemon↔browser pairing of Task 3). */
  async function adopt(daemon: WebSocket, browser: WebSocket): Promise<string> {
    const onBrowser = waitForEnvelope(browser, (e) => e.type === 'session.adopted');
    daemon.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.adopted', userId, deviceId, payload: { clientRef: 'c1' } }),
      ),
    );
    const frame = await onBrowser;
    return frame.session_id!;
  }

  function sendQuestion(daemon: WebSocket, sessionId: string): void {
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'agent.question',
          userId,
          deviceId,
          sessionId,
          payload: QUESTION_PAYLOAD,
        }),
      ),
    );
  }

  async function statusOf(sessionId: string): Promise<string> {
    const row = await admin.query<{ status: string }>('select status from sessions where id = $1', [
      sessionId,
    ]);
    return row.rows[0]!.status;
  }

  it('persists awaiting_input and broadcasts agent.question to the browser', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await adopt(daemon, browser);

    const onQuestion = waitForEnvelope(browser, (e) => e.type === 'agent.question');
    sendQuestion(daemon, sessionId);
    const received = await onQuestion;

    // The browser sees the question; once it does, the relay has already persisted awaiting_input
    // (markAwaitingInput is awaited before the broadcast).
    expect(received.session_id).toBe(sessionId);
    expect((received.payload as typeof QUESTION_PAYLOAD).questions[0]!.header).toBe('Database');
    expect(await statusOf(sessionId)).toBe('awaiting_input');

    daemon.close();
    browser.close();
  });

  it('flips the session back to running and forwards question.answer to the daemon', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await adopt(daemon, browser);
    const onQuestion = waitForEnvelope(browser, (e) => e.type === 'agent.question');
    sendQuestion(daemon, sessionId);
    await onQuestion;

    const onAnswer = waitForEnvelope(daemon, (e: Envelope) => e.type === 'question.answer');
    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'question.answer',
          userId,
          deviceId,
          sessionId,
          payload: { requestId: 'q1', answers: [{ selectedLabels: ['Postgres'] }] },
        }),
      ),
    );
    const forwarded = await onAnswer;

    // The daemon receives the opaque answer; by then the relay has already flipped the row to running.
    expect((forwarded.payload as { requestId: string }).requestId).toBe('q1');
    expect(await statusOf(sessionId)).toBe('running');

    daemon.close();
    browser.close();
  });

  it('caches agent.question so a reopening browser replays the pending question', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = await adopt(daemon, browser);
    const onQuestion = waitForEnvelope(browser, (e) => e.type === 'agent.question');
    sendQuestion(daemon, sessionId);
    await onQuestion;

    // A second browser reopens the session — the relay replays the cached question immediately.
    const reopened = await connectBrowser(relayUrl, userId, deviceId);
    const onReplay = waitForEnvelope(reopened, (e) => e.type === 'agent.question');
    reopened.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }),
      ),
    );
    const replayed = await onReplay;
    expect(replayed.session_id).toBe(sessionId);
    expect((replayed.payload as typeof QUESTION_PAYLOAD).questions[0]!.header).toBe('Database');

    daemon.close();
    browser.close();
    reopened.close();
  });
});
