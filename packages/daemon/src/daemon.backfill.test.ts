import { randomUUID } from 'node:crypto';

import { makeEnvelope, type Envelope, type SessionHistoryEntry } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter, type AgentEvent } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Phase 2 Task 11 — variant coverage for reconnect/backfill (`session.subscribe` → `session.history`),
 * the assertions deferred from Task 4. The daemon holds each session's transcript; on reopen it backfills
 * it so the UI restores. These prove the deferred shapes: a DENIED gate replays as decided (`deny`), a
 * still-open gate replays as `pending` (actionable), and a multi-turn session replays both turns.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

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
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

function send(
  relay: FakeRelay,
  type: 'session.launch' | 'permission.decision' | 'user.message' | 'session.subscribe',
  userId: string,
  deviceId: string,
  sessionId: string,
  payload: unknown,
): void {
  relay.send(makeEnvelope({ type, userId, deviceId, sessionId, payload }));
}

/** Subscribe and resolve with the backfilled history (the daemon's authoritative session state). */
async function history(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
  sessionId: string,
): Promise<{ status: string; entries: SessionHistoryEntry[] }> {
  send(relay, 'session.subscribe', userId, deviceId, sessionId, {});
  const frame = await relay.waitForFrame(
    (e) => e.type === 'session.history' && e.session_id === sessionId,
  );
  return frame.payload as { status: string; entries: SessionHistoryEntry[] };
}

const gate = (sessionId: string) => (e: Envelope) =>
  e.type === 'agent.permission_request' && e.session_id === sessionId;
const ended = (sessionId: string) => (e: Envelope) =>
  e.type === 'session.ended' && e.session_id === sessionId;

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('daemon backfill variants (Task 11)', () => {
  it('replays a denied gate as decided (deny), and the tool never ran', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Bash', input: { command: 'rm -rf /' } },
    ]);
    const sid = randomUUID();

    send(relay, 'session.launch', userId, deviceId, sid, { prompt: 'do something risky' });
    const request = await relay.waitForFrame(gate(sid));
    const requestId = (request.payload as { requestId: string }).requestId;
    send(relay, 'permission.decision', userId, deviceId, sid, { requestId, behavior: 'deny' });
    await relay.waitForFrame(ended(sid));

    const backfill = await history(relay, userId, deviceId, sid);
    expect(backfill.status).toBe('done');
    const permission = backfill.entries.find((e) => e.kind === 'permission');
    expect(permission && permission.kind === 'permission' ? permission.decision : null).toBe(
      'deny',
    );
    // The denied tool was never streamed as an executed tool entry.
    expect(backfill.entries.some((e) => e.kind === 'tool')).toBe(false);
  });

  it('replays a still-open gate as pending (actionable on reopen)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Write', input: { path: 'README.md' } },
    ]);
    const sid = randomUUID();

    send(relay, 'session.launch', userId, deviceId, sid, { prompt: 'write a file' });
    const request = await relay.waitForFrame(gate(sid));

    // Reopen mid-gate (no decision yet): the transcript backfills the open gate as pending.
    const backfill = await history(relay, userId, deviceId, sid);
    expect(backfill.status).toBe('awaiting_input');
    const permission = backfill.entries.find((e) => e.kind === 'permission');
    expect(permission && permission.kind === 'permission' ? permission.decision : null).toBe(
      'pending',
    );

    // Resolve it so the in-flight run finishes before teardown.
    const requestId = (request.payload as { requestId: string }).requestId;
    send(relay, 'permission.decision', userId, deviceId, sid, { requestId, behavior: 'allow' });
    await relay.waitForFrame(ended(sid));
  });

  it('replays a multi-turn session: both the launch and the follow-up turn', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    // An ungated turn (a message, no tool) so each turn completes on its own.
    const relay = await startDaemon(userId, deviceId, [{ type: 'message', text: 'working on it' }]);
    const sid = randomUUID();

    send(relay, 'session.launch', userId, deviceId, sid, { prompt: 'first task' });
    await relay.waitForFrame(ended(sid));
    send(relay, 'user.message', userId, deviceId, sid, { text: 'second task' });
    await relay.waitForFrame(ended(sid));

    const backfill = await history(relay, userId, deviceId, sid);
    expect(backfill.status).toBe('done');
    const userPrompts = backfill.entries.filter((e) => e.kind === 'user').map((e) => e.text);
    expect(userPrompts).toEqual(['first task', 'second task']);
    // Each turn streamed its agent message.
    expect(backfill.entries.filter((e) => e.kind === 'message')).toHaveLength(2);
  });
});
