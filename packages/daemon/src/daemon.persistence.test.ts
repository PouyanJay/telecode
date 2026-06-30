import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEnvelope, sessionHistoryPayloadSchema, type Envelope } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeAgentAdapter, type AgentEvent } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createSessionStore } from './sessions/session-store';

/**
 * Invariant #7 across a daemon restart: a finished session's transcript is persisted to disk and a brand-new
 * daemon process (fresh in-memory state) backfills it on `session.subscribe` — so a reopened-but-finished
 * session restores its real transcript instead of going blank. Real daemon + fake relay + temp store dir.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startDaemon(
  userId: string,
  deviceId: string,
  dir: string,
  events: AgentEvent[],
  sdkSessionId: string,
): Promise<FakeRelay> {
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    agentAdapter: createFakeAgentAdapter(events, { sessionId: sdkSessionId }),
    sessionStore: createSessionStore({ dir }),
    logger: silent,
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

describe('daemon transcript persistence (restart backfill)', () => {
  it('restores a finished session transcript after a daemon restart', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'telecode-daemon-'));
    dirs.push(dir);
    const sid = randomUUID();

    // Daemon #1: run a session to completion. The terminal state persists the transcript to `dir`.
    const relay1 = await startDaemon(
      userId,
      deviceId,
      dir,
      [{ type: 'message', text: 'the answer' }],
      'sdk-1',
    );
    relay1.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sid,
        payload: { prompt: 'q' },
      }),
    );
    await relay1.waitForFrame((e: Envelope) => e.type === 'session.ended' && e.session_id === sid);
    // The write is coalesced + async — wait for it to land on disk before "restarting".
    await vi.waitFor(
      async () => {
        expect((await createSessionStore({ dir }).loadAll()).has(sid)).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );

    // Daemon #2: a fresh process (empty in-memory state) pointed at the same store dir.
    const relay2 = await startDaemon(userId, deviceId, dir, [], 'sdk-2');
    relay2.send(
      makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId: sid, payload: {} }),
    );
    const frame = await relay2.waitForFrame(
      (e: Envelope) => e.type === 'session.history' && e.session_id === sid,
    );

    const payload = sessionHistoryPayloadSchema.parse(frame.payload);
    expect(payload.status).toBe('done');
    expect(payload.entries.some((e) => e.kind === 'message' && e.text === 'the answer')).toBe(true);
    expect(payload.entries.some((e) => e.kind === 'user' && e.text === 'q')).toBe(true);
  });
});
