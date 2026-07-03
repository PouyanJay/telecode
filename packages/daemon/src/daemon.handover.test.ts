import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEnvelope, type Envelope } from '@telecode/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFakeAgentAdapter,
  type AgentAdapter,
  type AgentRunOptions,
  type AgentRunResult,
} from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Free-form handover & resume, end-to-end through the daemon (Journey 4 walking skeleton): an adopted
 * session ends its turn asking a free-form question → the `Stop` hook makes the daemon offer a handover
 * (`agent.handover`, non-blocking) → the user answers (`handover.answer`) → the daemon registers a forked,
 * telecode-owned continuation (`session.chained`, linked to the parent) and runs it by RESUMING the adopted
 * conversation with `forkSession`, while the parent is marked handed-off. Real daemon + real socket + a fake
 * relay (stands in for relay + browser); a fake adapter records the fork-resume call.
 */
const USER = 'user-handover';
const DEVICE = 'device-handover';
const CLAUDE_SESSION = 'claude-sess-ff';
const PARENT_SESSION = '11111111-1111-1111-1111-111111111111';
const CHILD_SESSION = '22222222-2222-2222-2222-222222222222';

/** One bridge round-trip over the hook socket: write the event, half-close, read the decision JSON. */
function hookRpc(socketPath: string, event: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let out = '';
    client.on('connect', () => client.end(JSON.stringify(event)));
    client.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    client.on('end', () => {
      try {
        resolve(out === '' ? {} : JSON.parse(out));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('hook response parse failed'));
      }
    });
    client.on('error', reject);
  });
}

/** Reply to the daemon's `session.adopted` announce with the relay-minted id (pairs the Claude session). */
function ackAdopted(relay: FakeRelay, announce: Envelope): void {
  const clientRef = (announce.payload as { clientRef: string }).clientRef;
  relay.send(
    makeEnvelope({
      type: 'session.adopted',
      userId: USER,
      deviceId: DEVICE,
      sessionId: PARENT_SESSION,
      payload: { clientRef },
    }),
  );
}

/** Drive the read-only PreToolUse that first adopts the session, then ack the announce. */
async function adopt(relay: FakeRelay, socketPath: string): Promise<void> {
  const first = hookRpc(socketPath, {
    hook_event_name: 'PreToolUse',
    session_id: CLAUDE_SESSION,
    cwd: '/repo',
    tool_name: 'Read',
    tool_input: {},
  });
  ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
  await first;
}

describe('daemon: free-form handover & resume', () => {
  let relay: FakeRelay;
  let daemon: Daemon | undefined;
  let dir: string;
  let socketPath: string;

  beforeEach(async () => {
    relay = await startFakeRelay(USER, DEVICE);
    dir = await mkdtemp(join(tmpdir(), 'telecode-daemon-handover-'));
    socketPath = join(dir, 'run', 'hook.sock');
    daemon = undefined;
  });

  afterEach(async () => {
    await daemon?.stop();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Start a daemon with the given adapter (each test picks one to exercise the resume vs fallback path). */
  async function start(agentAdapter: AgentAdapter): Promise<void> {
    daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter,
      adopt: { socketPath, ackTimeoutMs: 2000 },
    });
    await daemon.start();
  }

  it('offers a handover on a free-form Stop, then forks-and-resumes the conversation on the answer', async () => {
    const runCalls: { prompt: string; resume?: string; forkSession?: boolean }[] = [];
    await start(
      createFakeAgentAdapter([{ type: 'message', text: 'Continuing with your answer.' }], {
        sessionId: 'fork-sdk-id',
        onRun: (call) => runCalls.push(call),
      }),
    );
    await adopt(relay, socketPath);

    // The adopted session ends its turn asking a free-form question → the Stop hook offers a handover.
    const stop = hookRpc(socketPath, {
      hook_event_name: 'Stop',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      last_assistant_message: 'Which database should we use for the app?',
    });
    const offer = await relay.waitForFrame((e) => e.type === 'agent.handover');
    expect(offer.session_id).toBe(PARENT_SESSION);
    const { requestId, question } = offer.payload as { requestId: string; question: string };
    expect(question).toContain('database');
    // Stop is NON-blocking — the hook returns immediately (the idle external process is never held).
    expect(await stop).toEqual({});

    // The user takes it over: answers the free-form question.
    relay.send(
      makeEnvelope({
        type: 'handover.answer',
        userId: USER,
        deviceId: DEVICE,
        sessionId: PARENT_SESSION,
        payload: { requestId, answerText: 'Use Postgres.' },
      }),
    );

    // The daemon registers a forked continuation linked to the adopted parent (no id yet) — ack it.
    const chained = await relay.waitForFrame((e) => e.type === 'session.chained');
    expect(chained.session_id).toBeUndefined();
    const chainPayload = chained.payload as {
      clientRef: string;
      parentSessionId: string;
      cwd?: string;
    };
    expect(chainPayload.parentSessionId).toBe(PARENT_SESSION);
    expect(chainPayload.cwd).toBe('/repo');
    relay.send(
      makeEnvelope({
        type: 'session.chained',
        userId: USER,
        deviceId: DEVICE,
        sessionId: CHILD_SESSION,
        payload: { clientRef: chainPayload.clientRef, parentSessionId: PARENT_SESSION },
      }),
    );

    // The child starts, the parent is handed off (ended), and the child ran by RESUMING the adopted
    // conversation with forkSession — the answer as its next turn.
    const started = await relay.waitForFrame(
      (e) => e.type === 'session.started' && e.session_id === CHILD_SESSION,
    );
    expect(started.session_id).toBe(CHILD_SESSION);
    const parentEnded = await relay.waitForFrame(
      (e) => e.type === 'session.ended' && e.session_id === PARENT_SESSION,
    );
    expect(parentEnded.status).toBe('done');
    await relay.waitForFrame((e) => e.type === 'session.ended' && e.session_id === CHILD_SESSION);

    await vi.waitFor(() =>
      expect(runCalls).toContainEqual({
        prompt: 'Use Postgres.',
        resume: CLAUDE_SESSION,
        forkSession: true,
      }),
    );
  });

  it('falls back to a summary-seeded fresh launch when the resume fails', async () => {
    // An adapter that fails the fork-resume of the (externally-created) conversation but succeeds a fresh
    // launch — the exact "resume unavailable" case the AD-7 fallback covers.
    const runCalls: { prompt: string; resume?: string; forkSession?: boolean }[] = [];
    const fallbackAdapter: AgentAdapter = {
      async run(prompt: string, opts: AgentRunOptions): Promise<AgentRunResult> {
        runCalls.push({
          prompt,
          ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
          ...(opts.forkSession !== undefined ? { forkSession: opts.forkSession } : {}),
        });
        if (opts.resume !== undefined) {
          throw new Error('cannot resume an externally-created conversation');
        }
        opts.onEvent({ type: 'message', text: 'Continuing from the handover summary.' });
        return { intercepted: [], allowed: [], denied: [], sessionId: 'fresh-sdk-id' };
      },
    };
    await start(fallbackAdapter);
    await adopt(relay, socketPath);

    const stop = hookRpc(socketPath, {
      hook_event_name: 'Stop',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      last_assistant_message: 'Which database should we use for the app?',
    });
    const offer = await relay.waitForFrame((e) => e.type === 'agent.handover');
    const { requestId } = offer.payload as { requestId: string };
    await stop;

    relay.send(
      makeEnvelope({
        type: 'handover.answer',
        userId: USER,
        deviceId: DEVICE,
        sessionId: PARENT_SESSION,
        payload: { requestId, answerText: 'Use Postgres.' },
      }),
    );

    const chained = await relay.waitForFrame((e) => e.type === 'session.chained');
    const { clientRef } = chained.payload as { clientRef: string };
    relay.send(
      makeEnvelope({
        type: 'session.chained',
        userId: USER,
        deviceId: DEVICE,
        sessionId: CHILD_SESSION,
        payload: { clientRef, parentSessionId: PARENT_SESSION },
      }),
    );

    // The child continuation still completes (done, not error) — via the fresh-launch fallback.
    const childEnded = await relay.waitForFrame(
      (e) => e.type === 'session.ended' && e.session_id === CHILD_SESSION,
    );
    expect(childEnded.status).toBe('done');

    // Two adapter runs: the failed fork-resume, then a fresh launch (no resume) seeded with the handover
    // context — carrying the exact question and the user's answer so the fresh conversation continues.
    await vi.waitFor(() => expect(runCalls).toHaveLength(2));
    expect(runCalls[0]).toMatchObject({ resume: CLAUDE_SESSION, forkSession: true });
    expect(runCalls[1]?.resume).toBeUndefined();
    expect(runCalls[1]?.forkSession).toBeUndefined();
    expect(runCalls[1]?.prompt).toContain('Which database should we use for the app?');
    expect(runCalls[1]?.prompt).toContain('Use Postgres.');
  });
});
