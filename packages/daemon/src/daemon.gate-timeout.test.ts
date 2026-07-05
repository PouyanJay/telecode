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
      250,
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
      250,
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
    const request = await relay.waitForFrame(ofType('agent.permission_request', sid));
    const { requestId } = (request.payload ?? {}) as { requestId: string };
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId,
        deviceId,
        sessionId: sid,
        payload: { requestId, behavior: 'allow' },
      }),
    );
    await relay.waitForFrame(ofType('session.ended', sid));

    // Well past the timeout, the approved verdict must stand — no late deny overwrote it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    relay.send(
      makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId: sid, payload: {} }),
    );
    const backfill = await relay.waitForFrame(ofType('session.history', sid));
    const history = sessionHistoryPayloadSchema.parse(backfill.payload);
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
    // Give a would-be timer ample room, then confirm the gate is still pending (no pushed deny).
    await new Promise((resolve) => setTimeout(resolve, 400));
    relay.send(
      makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId: sid, payload: {} }),
    );
    const backfill = await relay.waitForFrame(ofType('session.history', sid));
    const history = sessionHistoryPayloadSchema.parse(backfill.payload);
    expect(history.status).toBe('awaiting_input');
    expect(permissionEntry(history.entries)?.decision).toBe('pending');
  });
});
