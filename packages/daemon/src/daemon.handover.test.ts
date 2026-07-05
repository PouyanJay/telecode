import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeKey, generateKeyPair, makeEnvelope, type Envelope } from '@telecode/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFakeAgentAdapter,
  type AgentAdapter,
  type AgentRunOptions,
  type AgentRunResult,
} from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { markViewerPresent, startFakeRelay, type FakeRelay } from './fake-relay';

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

  /**
   * Start a daemon with the given adapter (each test picks one to exercise the resume vs fallback path).
   * A `keyPair` makes adopted sessions run end-to-end encrypted, exactly like a paired daemon.
   */
  async function start(
    agentAdapter: AgentAdapter,
    keyPair?: { publicKey: string; privateKey: string },
  ): Promise<void> {
    daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter,
      adopt: { socketPath, ackTimeoutMs: 2000, configPath: join(dir, 'adopt-config.json') },
      ...(keyPair ? { keyPair } : {}),
    });
    await daemon.start();
  }

  /** A Stop hook event for the adopted session with a given last assistant message. */
  function stopEvent(lastAssistantMessage: string, extra: Record<string, unknown> = {}): unknown {
    return {
      hook_event_name: 'Stop',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      last_assistant_message: lastAssistantMessage,
      ...extra,
    };
  }

  /** Set the daemon's adoption policy (cleartext, pre-E2E daemon) and wait for the adopt.state confirmation. */
  async function setAdoptConfig(enabled: boolean, denylist: string[]): Promise<void> {
    const onState = relay.waitForFrame((e) => e.type === 'adopt.state');
    relay.send(
      makeEnvelope({
        type: 'adopt.config',
        userId: USER,
        deviceId: DEVICE,
        payload: { set: { enabled, denylist } },
      }),
    );
    await onState;
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
    // vi.waitFor guaranteed length 2, so runCalls[1] exists — assert non-null so a regression can't slip past.
    expect(runCalls[1]!.resume).toBeUndefined();
    expect(runCalls[1]!.forkSession).toBeUndefined();
    expect(runCalls[1]!.prompt).toContain('Which database should we use for the app?');
    expect(runCalls[1]!.prompt).toContain('Use Postgres.');
  });

  it('does not offer a handover on a non-question Stop (only the free-form question offers)', async () => {
    await start(createFakeAgentAdapter([]));
    await adopt(relay, socketPath);

    // A non-question turn end must NOT offer. A later free-form question then must — and the FIRST (only)
    // handover frame carrying the question text proves the non-question Stop produced no offer (otherwise
    // it would arrive first, or park the session at awaiting_input and suppress this one).
    await hookRpc(socketPath, stopEvent('All done — the refactor is complete and tests pass.'));
    await hookRpc(socketPath, stopEvent('Which database should we use for the app?'));

    const offer = await relay.waitForFrame((e) => e.type === 'agent.handover');
    expect((offer.payload as { question: string }).question).toBe(
      'Which database should we use for the app?',
    );
  });

  it('does not offer on a re-entrant Stop (stop_hook_active guard)', async () => {
    await start(createFakeAgentAdapter([]));
    await adopt(relay, socketPath);

    await hookRpc(socketPath, stopEvent('Should I keep going?', { stop_hook_active: true }));
    await hookRpc(socketPath, stopEvent('Which region should we deploy to?'));

    const offer = await relay.waitForFrame((e) => e.type === 'agent.handover');
    expect((offer.payload as { question: string }).question).toBe(
      'Which region should we deploy to?',
    );
  });

  it('carries a deterministic summary of recent context from the transcript', async () => {
    await start(createFakeAgentAdapter([]));
    // A transcript with prior context the summary should extract (Claude JSONL record shapes).
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(
      transcriptPath,
      `${[
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Add a REST API for orders.' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I scaffolded the routes.' }],
          },
        }),
      ].join('\n')}\n`,
    );

    // Adopt via a PreToolUse carrying the transcript path (so the daemon mirrors the prior context).
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      transcript_path: transcriptPath,
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    await hookRpc(
      socketPath,
      stopEvent('Which database should we use?', { transcript_path: transcriptPath }),
    );
    const offer = await relay.waitForFrame((e) => e.type === 'agent.handover');
    const { summary } = offer.payload as { summary: string };
    expect(summary).toContain('User: Add a REST API for orders.');
    expect(summary).toContain('Assistant: I scaffolded the routes.');
  });

  it('sends the agent.handover offer as ciphertext to the relay (invariant #5)', async () => {
    const keyPair = await generateKeyPair();
    await start(createFakeAgentAdapter([]), {
      publicKey: encodeKey(keyPair.publicKey),
      privateKey: encodeKey(keyPair.privateKey),
    });
    await adopt(relay, socketPath);

    await hookRpc(socketPath, stopEvent('Which database should we use for the app?'));
    const offer = await relay.waitForFrame((e) => e.type === 'agent.handover');

    // The offer carries the free-form question (potentially sensitive prompt text) + a transcript summary —
    // both opaque to the relay: a ciphertext string with a non-empty nonce, never the cleartext object.
    expect(offer.nonce).not.toBe('');
    expect(typeof offer.payload).toBe('string');
  });

  it('does not offer a handover while a permission gate is already pending', async () => {
    await start(createFakeAgentAdapter([]));
    await adopt(relay, socketPath);
    await markViewerPresent(relay, USER, DEVICE); // a browser is watching → the consequential tool is gated

    // A consequential tool blocks on the approval gate → the session is awaiting_input.
    const gate = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 't1',
    });
    gate.catch(() => undefined);
    const request = await relay.waitForFrame((e) => e.type === 'agent.permission_request');
    const requestId = (request.payload as { requestId: string }).requestId;

    // While a gate is showing, a free-form Stop must NOT stack a handover offer on top of it.
    await hookRpc(socketPath, stopEvent('Should I proceed with plan A?'));

    // Resolve the gate → running again → a later question offers, and the FIRST handover frame carries
    // THAT question — proving the Stop-during-gate above produced no offer.
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId: USER,
        deviceId: DEVICE,
        sessionId: PARENT_SESSION,
        payload: { requestId, behavior: 'allow' },
      }),
    );
    await gate;
    await hookRpc(socketPath, stopEvent('Which region should we deploy to?'));

    const offer = await relay.waitForFrame((e) => e.type === 'agent.handover');
    expect((offer.payload as { question: string }).question).toBe(
      'Which region should we deploy to?',
    );
  });

  it('does not offer for a denylisted cwd, honoring a mid-session policy change', async () => {
    await start(createFakeAgentAdapter([]));
    await adopt(relay, socketPath);

    // The user denylists /repo AFTER adoption — a handover (which launches a new session) must be gated.
    await setAdoptConfig(true, ['/repo']);
    await hookRpc(socketPath, stopEvent('Which database should we use?'));

    // Re-allow, then a question offers — the FIRST handover carries THIS question, proving the denylisted
    // Stop above produced no offer.
    await setAdoptConfig(true, []);
    await hookRpc(socketPath, stopEvent('Which region should we deploy to?'));

    const offer = await relay.waitForFrame((e) => e.type === 'agent.handover');
    expect((offer.payload as { question: string }).question).toBe(
      'Which region should we deploy to?',
    );
  });
});
