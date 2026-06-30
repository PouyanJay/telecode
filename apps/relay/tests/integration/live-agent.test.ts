import type { AddressInfo } from 'node:net';

import { createClaudeAgentAdapter, createDaemon, type Daemon } from '@telecode/daemon';
import {
  agentMessagePayloadSchema,
  agentPermissionRequestPayloadSchema,
  makeEnvelope,
  parseEnvelope,
  sessionEndedPayloadSchema,
  type Envelope,
} from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { expectSessionStatus } from '../_helpers/db';
import { connectBrowser } from '../_helpers/ws';

/**
 * Task 9 — the opt-in **live** end-to-end harness. Unlike every other suite (which drives the
 * deterministic fake adapter), this launches a **real Claude Agent SDK** session and proves it streams
 * through the real relay + real Postgres + an in-process daemon, then resumes for a follow-up turn — the
 * full Phase 1 loop against the actual model.
 *
 * It is **flag-gated and skipped by default** (so it never runs in CI or a normal `pnpm test`): set
 * `TELECODE_LIVE_E2E=1` with a valid `ANTHROPIC_API_KEY`. Run it **standalone, outside Claude Code** —
 * nested in Claude Code the SDK routes tool permissions to the parent harness (the proven Spike-1
 * caveat), so `canUseTool` would be bypassed. A cheap model (Haiku) bounds the API spend.
 *
 *   TELECODE_LIVE_E2E=1 pnpm --filter @telecode/relay exec vitest run tests/integration/live-agent
 */
const LIVE = process.env.TELECODE_LIVE_E2E === '1' && Boolean(process.env.ANTHROPIC_API_KEY);
const DATABASE_URL = process.env.DATABASE_URL;
const MODEL = process.env.TELECODE_LIVE_MODEL ?? 'claude-haiku-4-5-20251001';

/** Resolve when the browser has received `count` `session.ended` frames (one per turn). */
function waitForEndedCount(received: Envelope[], count: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`timed out waiting for ${count} session.ended`));
    }, timeoutMs);
    const poll = setInterval(() => {
      if (received.filter((e) => e.type === 'session.ended').length >= count) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 100);
  });
}

describe.skipIf(!LIVE)('LIVE: real Claude Agent SDK session through the relay', () => {
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
      "insert into users (provider, provider_user_id) values ('dev', 'live') returning id",
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

    // The real SDK adapter — a cheap model, isolated settings, no tools needed for a text reply.
    daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      logger: pino({ level: 'silent' }),
      agentAdapter: createClaudeAgentAdapter({ model: MODEL, maxTurns: 2 }),
    });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon?.stop();
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  it(
    'streams a real agent reply and resumes the conversation for a follow-up',
    { timeout: 120_000 },
    async () => {
      const browser = await connectBrowser(relayUrl, userId, deviceId);
      const received: Envelope[] = [];
      browser.on('message', (raw: Buffer) => {
        const envelope = parseEnvelope(JSON.parse(raw.toString()));
        received.push(envelope);
        // Auto-approve any tool the model decides to use so the harness never blocks.
        if (envelope.type === 'agent.permission_request' && envelope.session_id) {
          const { requestId } = agentPermissionRequestPayloadSchema.parse(envelope.payload);
          browser.send(
            JSON.stringify(
              makeEnvelope({
                type: 'permission.decision',
                userId,
                deviceId,
                sessionId: envelope.session_id,
                payload: { requestId, behavior: 'allow' },
              }),
            ),
          );
        }
      });

      // Turn 1 — launch.
      browser.send(
        JSON.stringify(
          makeEnvelope({
            type: 'session.launch',
            userId,
            deviceId,
            payload: { prompt: 'Reply with exactly one word: hello. Do not use any tools.' },
          }),
        ),
      );
      await waitForEndedCount(received, 1, 90_000);

      const sessionId = received[0]?.session_id;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      if (sessionId === undefined) throw new Error('no session id');

      const firstTurnText = received
        .filter((e) => e.type === 'agent.message')
        .map((e) => agentMessagePayloadSchema.parse(e.payload).text)
        .join(' ');
      expect(firstTurnText.length).toBeGreaterThan(0);

      // Turn 2 — a real follow-up that resumes the same conversation.
      browser.send(
        JSON.stringify(
          makeEnvelope({
            type: 'user.message',
            userId,
            deviceId,
            sessionId,
            payload: { text: 'Now reply with exactly one word: goodbye. Do not use any tools.' },
          }),
        ),
      );
      await waitForEndedCount(received, 2, 90_000);

      // Both turns produced real agent output and ended cleanly on the same session.
      const messageCount = received.filter((e) => e.type === 'agent.message').length;
      expect(messageCount).toBeGreaterThanOrEqual(2);
      const endings = received
        .filter((e) => e.type === 'session.ended')
        .map((e) => sessionEndedPayloadSchema.parse(e.payload).status);
      expect(endings).toEqual(['done', 'done']);

      await expectSessionStatus(admin, sessionId, 'done');

      browser.close();
    },
  );
});
