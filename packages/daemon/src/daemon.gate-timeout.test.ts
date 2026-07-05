import { randomUUID } from 'node:crypto';

import {
  makeEnvelope,
  sessionHistoryPayloadSchema,
  type Envelope,
  type SessionHistoryEntry,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentEvent } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Gate timeout (approval-reliability T2). A pending permission gate must never block an agent turn
 * forever: with no operator decision within `gateTimeoutMs` the daemon denies it (with an explanatory
 * message), the turn resumes, and watching browsers are un-stuck via a pushed `session.history` whose
 * entry reads denied — the gate card can't spin forever. `gateTimeoutMs <= 0` disables the timer
 * (the pre-timeout behavior).
 */
const silent = pino({ level: 'silent' });
/** Short enough for fast tests; every wait below is event-driven (frames), never a wall-clock sleep. */
const TEST_GATE_TIMEOUT_MS = 250;
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

async function startDaemon(
  userId: string,
  deviceId: string,
  events: AgentEvent[],
  gateTimeoutMs?: number,
): Promise<FakeRelay> {
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    agentAdapter: createFakeAgentAdapter(events, { sessionId: 'sdk-1' }),
    logger: silent,
    ...(gateTimeoutMs !== undefined ? { gateTimeoutMs } : {}),
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

const ofType = (type: string, sessionId: string) => (e: Envelope) =>
  e.type === type && e.session_id === sessionId;

const permissionEntry = (
  entries: SessionHistoryEntry[],
): Extract<SessionHistoryEntry, { kind: 'permission' }> | undefined =>
  entries.find(
    (e): e is Extract<SessionHistoryEntry, { kind: 'permission' }> => e.kind === 'permission',
  );

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('daemon: permission gate timeout', () => {
  it('denies an unanswered gate after the timeout, un-sticks watchers, and lets the turn finish', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(
      userId,
      deviceId,
      [{ type: 'tool_use', toolName: 'Bash', input: { command: 'rm -rf /' } }],
      TEST_GATE_TIMEOUT_MS,
    );
    const sid = randomUUID();

    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sid,
        payload: { prompt: 'run it' },
      }),
    );
    await relay.waitForFrame(ofType('agent.permission_request', sid));

    // Nobody answers. The daemon must resolve the gate itself: watchers get a PUSHED history whose
    // permission entry reads denied (no subscribe from us), and the turn then ends.
    const pushed = await relay.waitForFrame(ofType('session.history', sid));
    const history = sessionHistoryPayloadSchema.parse(pushed.payload);
    expect(permissionEntry(history.entries)?.decision).toBe('deny');
    await relay.waitForFrame(ofType('session.ended', sid));
  });

  it('does not fire after a decision resolved the gate in time', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(
      userId,
      deviceId,
      [{ type: 'tool_use', toolName: 'Bash', input: { command: 'echo ok' } }],
      TEST_GATE_TIMEOUT_MS,
    );
    const decided = randomUUID();

    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: decided,
        payload: { prompt: 'run it' },
      }),
    );
    const request = await relay.waitForFrame(ofType('agent.permission_request', decided));
    const { requestId } = (request.payload ?? {}) as { requestId: string };
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId,
        deviceId,
        sessionId: decided,
        payload: { requestId, behavior: 'allow' },
      }),
    );
    await relay.waitForFrame(ofType('session.ended', decided));

    // Event-driven "a full timeout window elapsed" barrier: a SECOND gated session, launched after
    // the decision above, is left unanswered — its own timer (armed later than the first one would
    // have fired) times out and pushes its deny. A leaked timer on the decided session would have
    // fired before this. No wall-clock sleeps (TDD no-timing-tests rule).
    const sentinel = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sentinel,
        payload: { prompt: 'never answered' },
      }),
    );
    await relay.waitForFrame(ofType('agent.permission_request', sentinel));
    await relay.waitForFrame(ofType('session.history', sentinel));

    relay.send(
      makeEnvelope({
        type: 'session.subscribe',
        userId,
        deviceId,
        sessionId: decided,
        payload: {},
      }),
    );
    const backfill = await relay.waitForFrame(ofType('session.history', decided));
    const history = sessionHistoryPayloadSchema.parse(backfill.payload);
    // The timely approval stands — no late deny overwrote it.
    expect(permissionEntry(history.entries)?.decision).toBe('allow');
    expect(history.entries.some((e) => e.kind === 'tool')).toBe(true);
  });

  it('never times out when disabled (gateTimeoutMs: 0)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(
      userId,
      deviceId,
      [{ type: 'tool_use', toolName: 'Bash', input: { command: 'echo hi' } }],
      0,
    );
    const sid = randomUUID();

    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sid,
        payload: { prompt: 'run it' },
      }),
    );
    await relay.waitForFrame(ofType('agent.permission_request', sid));
    // No wait needed: with the timer disabled nothing was armed. A regression that armed a 0ms timer
    // would push its deny before this subscribe round-trip completes, failing the asserts below.
    relay.send(
      makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId: sid, payload: {} }),
    );
    const backfill = await relay.waitForFrame(ofType('session.history', sid));
    const history = sessionHistoryPayloadSchema.parse(backfill.payload);
    expect(history.status).toBe('awaiting_input');
    expect(permissionEntry(history.entries)?.decision).toBe('pending');
  });
});
