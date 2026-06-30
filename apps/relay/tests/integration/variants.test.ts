import type { AddressInfo } from 'node:net';

import {
  createDaemon,
  createFakeAgentAdapter,
  type AgentAdapter,
  type Daemon,
} from '@telecode/daemon';
import {
  agentPermissionRequestPayloadSchema,
  makeEnvelope,
  parseEnvelope,
  sessionEndedPayloadSchema,
  type Envelope,
} from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { expectSessionStatus } from '../_helpers/db';
import { connectBrowser } from '../_helpers/ws';

/**
 * Task 10 — variant coverage for the session path: a session is broadcast to every watching browser; a
 * failing agent run and an invalid launch both end the session in `error` (no stuck `starting` row); and
 * only one turn runs at a time per session (a follow-up that races an in-flight turn is dropped). Real
 * relay + real Postgres + in-process daemon; the daemon's adapter is swapped per test.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SILENT = pino({ level: 'silent' });

/** A frame collector with count-based waiting (resilient to frames that arrive before we await). */
function makeCollector(socket: WebSocket): {
  frames: Envelope[];
  count(type: string): number;
  waitForCount(type: string, n: number, timeoutMs?: number): Promise<void>;
} {
  const frames: Envelope[] = [];
  const waiters: { check: () => boolean; resolve: () => void }[] = [];
  socket.on('message', (raw: Buffer) => {
    frames.push(parseEnvelope(JSON.parse(raw.toString())));
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.check()) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  });
  const count = (type: string): number => frames.filter((f) => f.type === type).length;
  return {
    frames,
    count,
    waitForCount(type, n, timeoutMs = 5000): Promise<void> {
      return new Promise((resolve, reject) => {
        const check = (): boolean => count(type) >= n;
        if (check()) return resolve();
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${n} ${type}`)),
          timeoutMs,
        );
        waiters.push({ check, resolve: () => (clearTimeout(timer), resolve()) });
      });
    },
  };
}

describe('session variants: broadcast, error paths, and the one-turn-at-a-time guard', () => {
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
    const u = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'variants') returning id",
    );
    userId = u.rows[0]!.id;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'lap', 'h') returning id",
      [userId],
    );
    deviceId = d.rows[0]!.id;

    app = await buildRelay({
      logger: SILENT,
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

  /** Run `fn` with a freshly-started daemon using `adapter`, stopping it afterwards. */
  async function withDaemon(adapter: AgentAdapter, fn: () => Promise<void>): Promise<void> {
    const daemon: Daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      logger: SILENT,
      agentAdapter: adapter,
    });
    await daemon.start();
    try {
      await fn();
    } finally {
      await daemon.stop();
    }
  }

  function launch(socket: WebSocket, prompt: unknown): void {
    socket.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.launch', userId, deviceId, payload: { prompt } }),
      ),
    );
  }

  /** Approve the most recent permission request seen on `frames` (sent from `socket`). */
  function approveLatest(socket: WebSocket, frames: Envelope[]): void {
    const request = [...frames].reverse().find((f) => f.type === 'agent.permission_request');
    if (!request?.session_id) throw new Error('no permission request to approve');
    const { requestId } = agentPermissionRequestPayloadSchema.parse(request.payload);
    socket.send(
      JSON.stringify(
        makeEnvelope({
          type: 'permission.decision',
          userId,
          deviceId,
          sessionId: request.session_id,
          payload: { requestId, behavior: 'allow' },
        }),
      ),
    );
  }

  // Runs first, before any test connects a daemon, so the channel genuinely has none.
  it('fails a launch when no daemon is connected (device offline), not a stuck starting row', async () => {
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const col = makeCollector(browser);
    launch(browser, 'do it');
    await col.waitForCount('session.ended', 1);

    // The browser connected with no daemon, so it first gets a `device.presence` offline frame (Phase 4
    // Task 3) — orthogonal to this test, which asserts the launch fails rather than sticking at `starting`.
    const lifecycle = col.frames.filter((f) => f.type !== 'device.presence');
    expect(lifecycle.map((f) => f.type)).toEqual(['session.ended']);
    expect(sessionEndedPayloadSchema.parse(lifecycle[0]!.payload).status).toBe('error');

    const sessionId = lifecycle[0]?.session_id;
    await expectSessionStatus(admin, sessionId, 'error');
    browser.close();
  });

  it('broadcasts the whole session to every browser watching the channel', async () => {
    const adapter = createFakeAgentAdapter([
      { type: 'message', text: 'hi' },
      // A consequential tool so the human gate fires (a read-only tool would auto-approve, no broadcast).
      { type: 'tool_use', toolName: 'Bash', input: { command: 'echo x' } },
      { type: 'message', text: 'bye' },
    ]);
    await withDaemon(adapter, async () => {
      const a = await connectBrowser(relayUrl, userId, deviceId);
      const b = await connectBrowser(relayUrl, userId, deviceId);
      const colA = makeCollector(a);
      const colB = makeCollector(b);

      // The *second* browser approves — proving any watcher can act, and both see the result.
      b.on('message', (raw: Buffer) => {
        const envelope = parseEnvelope(JSON.parse(raw.toString()));
        if (envelope.type === 'agent.permission_request') approveLatest(b, colB.frames);
      });

      launch(a, 'do it');
      await Promise.all([
        colA.waitForCount('session.ended', 1),
        colB.waitForCount('session.ended', 1),
      ]);

      const expected = [
        'session.started',
        'agent.message',
        'agent.permission_request',
        'agent.tool_use',
        'agent.message',
        'session.ended',
      ];
      expect(colA.frames.map((f) => f.type)).toEqual(expected);
      expect(colB.frames.map((f) => f.type)).toEqual(expected);

      a.close();
      b.close();
    });
  });

  it('ends the session in error when the agent run throws', async () => {
    const throwing: AgentAdapter = {
      run() {
        return Promise.reject(new Error('kaboom'));
      },
    };
    await withDaemon(throwing, async () => {
      const browser = await connectBrowser(relayUrl, userId, deviceId);
      const col = makeCollector(browser);
      launch(browser, 'do it');
      await col.waitForCount('session.ended', 1);

      expect(col.frames.map((f) => f.type)).toEqual(['session.started', 'session.ended']);
      const ended = sessionEndedPayloadSchema.parse(
        col.frames.find((f) => f.type === 'session.ended')!.payload,
      );
      expect(ended.status).toBe('error');

      const sessionId = col.frames[0]?.session_id;
      await expectSessionStatus(admin, sessionId, 'error');
      browser.close();
    });
  });

  it('ends the session in error when the launch payload is invalid (no stuck starting row)', async () => {
    const adapter = createFakeAgentAdapter([{ type: 'message', text: 'unreached' }]);
    await withDaemon(adapter, async () => {
      const browser = await connectBrowser(relayUrl, userId, deviceId);
      const col = makeCollector(browser);
      launch(browser, ''); // empty prompt — rejected by the daemon's schema
      await col.waitForCount('session.ended', 1);

      // The agent never started; the session failed cleanly.
      expect(col.frames.map((f) => f.type)).toEqual(['session.ended']);
      expect(sessionEndedPayloadSchema.parse(col.frames[0]!.payload).status).toBe('error');

      const sessionId = col.frames[0]?.session_id;
      await expectSessionStatus(admin, sessionId, 'error');
      browser.close();
    });
  });

  it('runs one turn at a time per session: a follow-up during an active turn is dropped', async () => {
    // Each turn streams a message then a gated tool, so a turn stays blocked until approved. A read-only
    // tool would auto-approve and never block, so use a consequential one to hold the turn at the gate.
    const adapter = createFakeAgentAdapter([
      { type: 'message', text: 'turn' },
      { type: 'tool_use', toolName: 'Bash', input: { command: 'echo hi' } },
    ]);
    await withDaemon(adapter, async () => {
      const browser = await connectBrowser(relayUrl, userId, deviceId);
      const col = makeCollector(browser);

      // Turn 1: launch → gate → approve → ended.
      launch(browser, 'first');
      await col.waitForCount('agent.permission_request', 1);
      const sessionId = col.frames[0]?.session_id;
      if (sessionId === undefined) throw new Error('no session id');
      approveLatest(browser, col.frames);
      await col.waitForCount('session.ended', 1);

      function followUp(sid: string, text: string): void {
        browser.send(
          JSON.stringify(
            makeEnvelope({
              type: 'user.message',
              userId,
              deviceId,
              sessionId: sid,
              payload: { text },
            }),
          ),
        );
      }

      // Turn 2: follow-up that gates and blocks (the turn is now in flight).
      followUp(sessionId, 'second');
      await col.waitForCount('agent.permission_request', 2);

      // Race a follow-up while turn 2 is in flight, then immediately approve. Frames are ordered per
      // connection, so the daemon sees (and drops) the racing follow-up before the approval resolves
      // turn 2 — no third turn can start. The drop is therefore observed deterministically, no sleeps.
      followUp(sessionId, 'third — should be dropped');
      approveLatest(browser, col.frames);
      await col.waitForCount('session.ended', 2);

      // Exactly two turns ran; the racing follow-up never spawned a third.
      expect(col.count('session.ended')).toBe(2);
      expect(col.count('agent.permission_request')).toBe(2);
      browser.close();
    });
  });
});
