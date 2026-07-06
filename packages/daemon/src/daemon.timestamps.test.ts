import { randomUUID } from 'node:crypto';

import { makeEnvelope, type Envelope, type SessionHistoryEntry } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter, type AgentEvent } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Phase 3 (threads & lineage) Task 1 — per-entry timestamps on the wire. The daemon stamps every
 * transcript entry it records with an injected clock (`ts`, epoch ms), carries the same stamp on the
 * live entry-producing frames, and replays it in the `session.history` backfill — so entry times stay
 * honest across reloads instead of resetting to the browser's receive time.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

/** A deterministic clock: each call returns the next instant, so stamps are distinct + ordered. */
const CLOCK_BASE = 1_783_290_000_000;
function tickingClock(): () => number {
  let calls = 0;
  return () => CLOCK_BASE + calls++ * 1_000;
}

async function startDaemon(
  userId: string,
  deviceId: string,
  events: AgentEvent[],
): Promise<FakeRelay> {
  const adapter: AgentAdapter = createFakeAgentAdapter(events, { sessionId: 'sdk-1' });
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    agentAdapter: adapter,
    logger: silent,
    now: tickingClock(),
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

function send(
  relay: FakeRelay,
  type: 'session.launch' | 'permission.decision' | 'session.subscribe',
  userId: string,
  deviceId: string,
  sessionId: string,
  payload: unknown,
): void {
  relay.send(makeEnvelope({ type, userId, deviceId, sessionId, payload }));
}

const ofType = (type: string, sessionId: string) => (e: Envelope) =>
  e.type === type && e.session_id === sessionId;

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('per-entry timestamps (Phase 3 Task 1)', () => {
  it('stamps live entry frames and the history backfill with the injected clock', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [{ type: 'message', text: 'working on it' }]);
    const sid = randomUUID();

    send(relay, 'session.launch', userId, deviceId, sid, { prompt: 'first task' });
    const live = await relay.waitForFrame(ofType('agent.message', sid));
    const livePayload = live.payload as { text: string; ts?: number };
    expect(livePayload.ts).toBeTypeOf('number');
    expect(livePayload.ts).toBeGreaterThanOrEqual(CLOCK_BASE);
    await relay.waitForFrame(ofType('session.ended', sid));

    send(relay, 'session.subscribe', userId, deviceId, sid, {});
    const backfill = await relay.waitForFrame(ofType('session.history', sid));
    const { entries } = backfill.payload as { entries: SessionHistoryEntry[] };
    // Every recorded entry (the user prompt + the agent message) carries a distinct, ordered stamp.
    const stamps = entries.map((entry) => entry.ts);
    expect(stamps).toHaveLength(2);
    for (const ts of stamps) expect(ts).toBeTypeOf('number');
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(stamps);
    // The agent message's backfilled stamp is the SAME instant the live frame carried — one stamp
    // per entry, minted once at record time, not re-minted per send.
    const message = entries.find((entry) => entry.kind === 'message');
    expect(message?.ts).toBe(livePayload.ts);
  });

  it('stamps a permission gate once: the live request and its backfilled entry agree', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Write', input: { path: 'README.md' } },
    ]);
    const sid = randomUUID();

    send(relay, 'session.launch', userId, deviceId, sid, { prompt: 'write a file' });
    const request = await relay.waitForFrame(ofType('agent.permission_request', sid));
    const requestPayload = request.payload as { requestId: string; ts?: number };
    expect(requestPayload.ts).toBeTypeOf('number');

    send(relay, 'session.subscribe', userId, deviceId, sid, {});
    const backfill = await relay.waitForFrame(ofType('session.history', sid));
    const { entries } = backfill.payload as { entries: SessionHistoryEntry[] };
    const gateEntry = entries.find((entry) => entry.kind === 'permission');
    expect(gateEntry?.ts).toBe(requestPayload.ts);

    // Settle the gate so the in-flight run finishes before teardown.
    send(relay, 'permission.decision', userId, deviceId, sid, {
      requestId: requestPayload.requestId,
      behavior: 'allow',
    });
    await relay.waitForFrame(ofType('session.ended', sid));
  });
});
