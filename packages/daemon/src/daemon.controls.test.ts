import { randomUUID } from 'node:crypto';

import { makeEnvelope, type Envelope, type SessionHistoryEntry } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Phase 2 Task 9 — per-session controls through the real daemon (over the fake-relay WS). Interrupt
 * aborts the in-flight turn (the session stays followable); end terminates it (follow-ups refused);
 * pause refuses new turns and reports `paused` without freezing an in-flight turn; resume re-enables.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

/** Rejects only when the signal aborts — lets an adapter "run" until interrupt/end aborts it. */
function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new Error('aborted'));
    else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

/** Streams a message then returns immediately (a turn that completes; the session goes idle). */
function quickAdapter(prompts: string[]): AgentAdapter {
  return {
    async run(prompt, { onEvent }) {
      prompts.push(prompt);
      onEvent({ type: 'message', text: `ack: ${prompt}` });
      return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
    },
  };
}

/** Streams a message, then blocks at the permission gate until the human decides (or the run aborts). */
function gatedAdapter(prompts: string[]): AgentAdapter {
  return {
    async run(prompt, { canUseTool, onEvent, signal }) {
      prompts.push(prompt);
      onEvent({ type: 'message', text: 'working' });
      const decision = await Promise.race([
        canUseTool({ toolName: 'Bash', input: { command: 'echo hi' } }),
        abortPromise(signal),
      ]);
      if (decision.behavior === 'allow') {
        onEvent({ type: 'tool_use', toolName: 'Bash', input: { command: 'echo hi' } });
      }
      return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
    },
  };
}

/**
 * Streams a message then blocks until aborted, then returns its conversation id — models the real
 * adapter, which on interrupt/end returns gracefully (so the session stays resumable).
 */
function blockingAdapter(prompts: string[]): AgentAdapter {
  return {
    async run(prompt, { onEvent, signal }) {
      prompts.push(prompt);
      onEvent({ type: 'message', text: 'working' });
      try {
        await abortPromise(signal);
      } catch {
        // interrupted — fall through and return the captured conversation id
      }
      return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
    },
  };
}

/** Streams a message then rejects on abort — exercises the daemon's catch-abort fallback (→ done, not error). */
function rejectingAdapter(prompts: string[]): AgentAdapter {
  return {
    async run(prompt, { onEvent, signal }) {
      prompts.push(prompt);
      onEvent({ type: 'message', text: 'working' });
      await abortPromise(signal); // rejects on abort and is never caught
      return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
    },
  };
}

async function startDaemon(
  userId: string,
  deviceId: string,
  adapter: AgentAdapter,
): Promise<FakeRelay> {
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

function launch(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
  sessionId: string,
  prompt: string,
): void {
  relay.send(
    makeEnvelope({ type: 'session.launch', userId, deviceId, sessionId, payload: { prompt } }),
  );
}

function control(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
  sessionId: string,
  action: 'end' | 'interrupt',
): void {
  relay.send(
    makeEnvelope({ type: 'session.control', userId, deviceId, sessionId, payload: { action } }),
  );
}

function followUp(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
  sessionId: string,
  text: string,
): void {
  relay.send(
    makeEnvelope({ type: 'user.message', userId, deviceId, sessionId, payload: { text } }),
  );
}

/** Subscribe and resolve with the backfilled history (the daemon's authoritative session state). */
async function history(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
  sessionId: string,
): Promise<{ status: string; entries: SessionHistoryEntry[] }> {
  relay.send(makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }));
  const frame = await relay.waitForFrame(
    (e) => e.type === 'session.history' && e.session_id === sessionId,
  );
  return frame.payload as { status: string; entries: SessionHistoryEntry[] };
}

const ended = (sessionId: string) => (e: Envelope) =>
  e.type === 'session.ended' && e.session_id === sessionId;
const gate = (sessionId: string) => (e: Envelope) =>
  e.type === 'agent.permission_request' && e.session_id === sessionId;

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('daemon: per-session controls (Task 9)', () => {
  it('interrupt aborts a running turn and ends it cleanly (done), and the session stays followable', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const prompts: string[] = [];
    const relay = await startDaemon(userId, deviceId, blockingAdapter(prompts));
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, 'run forever');
    await relay.waitForFrame((e) => e.type === 'agent.message' && e.session_id === sid);

    control(relay, userId, deviceId, sid, 'interrupt');
    const end = await relay.waitForFrame(ended(sid));
    expect((end.payload as { status: string }).status).toBe('done');

    // Followable: a follow-up resumes the session for a new turn.
    followUp(relay, userId, deviceId, sid, 'try again');
    await relay.waitForFrame((e) => e.type === 'agent.message' && e.session_id === sid);
    expect(prompts).toEqual(['run forever', 'try again']);
  });

  it('ends an interrupted turn as done (not error) even when the adapter rejects on abort', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, rejectingAdapter([]));
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, 'run forever');
    await relay.waitForFrame((e) => e.type === 'agent.message' && e.session_id === sid);

    control(relay, userId, deviceId, sid, 'interrupt');
    const end = await relay.waitForFrame(ended(sid));
    expect((end.payload as { status: string }).status).toBe('done');
  });

  it('interrupt while awaiting a gate settles the gate as denied (not left pending)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, gatedAdapter([]));
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, 'do a thing');
    await relay.waitForFrame(gate(sid));

    control(relay, userId, deviceId, sid, 'interrupt');
    await relay.waitForFrame(ended(sid));

    const backfill = await history(relay, userId, deviceId, sid);
    expect(backfill.status).toBe('done');
    const permission = backfill.entries.find((e) => e.kind === 'permission');
    // Settled (no longer actionable on reopen), not stranded as `pending`.
    expect(permission && permission.kind === 'permission' ? permission.decision : null).toBe(
      'deny',
    );
  });

  it('end terminates the session and refuses further follow-ups', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const prompts: string[] = [];
    const relay = await startDaemon(userId, deviceId, quickAdapter(prompts));
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, 'first');
    await relay.waitForFrame(ended(sid));

    control(relay, userId, deviceId, sid, 'end');
    await relay.waitForFrame(ended(sid));

    // A follow-up after end is refused; a fresh session still runs (an ordering barrier proving the
    // refused follow-up was processed and dropped, never run).
    followUp(relay, userId, deviceId, sid, 'after end');
    const sid2 = randomUUID();
    launch(relay, userId, deviceId, sid2, 'new session');
    await relay.waitForFrame(ended(sid2));

    expect(prompts).toEqual(['first', 'new session']);
  });

  it('a session stays followable after interrupt — a follow-up resumes it', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const prompts: string[] = [];
    const relay = await startDaemon(userId, deviceId, blockingAdapter(prompts));
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, 'run forever');
    await relay.waitForFrame((e) => e.type === 'agent.message' && e.session_id === sid);
    control(relay, userId, deviceId, sid, 'interrupt');
    await relay.waitForFrame(ended(sid));

    // Unlike end, interrupt leaves the session open: the next message just continues it.
    followUp(relay, userId, deviceId, sid, 'keep going');
    await relay.waitForFrame((e) => e.type === 'agent.message' && e.session_id === sid);
    expect(prompts).toEqual(['run forever', 'keep going']);
  });
});
