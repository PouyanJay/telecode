import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  encodeKey,
  generateKeyPair,
  makeEnvelope,
  sessionMetaPayloadSchema,
  type Envelope,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import {
  decryptWithContentKey,
  mkE2eIds,
  sealEnvelopePayload,
  sendSealedLaunch,
  startE2eDaemon,
  unwrapContentKey,
} from './e2e-harness';
import { hookRpc } from './hook-rpc';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createGitWorktreeManager } from './sessions/worktree-manager';

const execFileAsync = promisify(execFile);

/** Run one git command in `cwd`, returning stdout (test-only convenience). */
async function runGitCmd(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args])).stdout;
}

/**
 * Resume-as-new (session-identity T8), daemon leg. A `session.resume_new` on a TERMINAL session mints a
 * NEW linked session through the existing `session.chained` machinery and runs the prompt there: a
 * fork-resume (`resume` + `forkSession`) when the parent conversation is still resumable, a plain fresh
 * launch when it isn't (needs_restart, or a parent only the relay remembers). The parent is left exactly
 * as it ended — never re-ended, never resumed in place. Real daemon + real socket + fake relay/adapter.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

const ofType = (type: string, sessionId: string) => (e: Envelope) =>
  e.type === type && e.session_id === sessionId;

interface RunCall {
  prompt: string;
  resume?: string;
  forkSession?: boolean;
  cwd?: string;
}

async function startDaemon(
  adapter: AgentAdapter,
  extras: Partial<Parameters<typeof createDaemon>[0]> = {},
): Promise<{
  relay: FakeRelay;
  userId: string;
  deviceId: string;
}> {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    agentAdapter: adapter,
    logger: silent,
    ...extras,
  });
  daemons.push(daemon);
  await daemon.start();
  return { relay, userId, deviceId };
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

/** Launch a session and run it to its terminal frame; returns the ended envelope. */
async function launchToEnd(
  relay: FakeRelay,
  ids: { userId: string; deviceId: string },
  sessionId: string,
  prompt: string,
): Promise<Envelope> {
  relay.send(
    makeEnvelope({
      type: 'session.launch',
      userId: ids.userId,
      deviceId: ids.deviceId,
      sessionId,
      payload: { prompt },
    }),
  );
  return relay.waitForFrame(ofType('session.ended', sessionId));
}

function sendResumeNew(
  relay: FakeRelay,
  ids: { userId: string; deviceId: string },
  parentId: string,
  payload: {
    prompt: string;
    clientRef?: string;
    baseBranch?: string;
    branchName?: string;
    permissionMode?: string;
  },
): void {
  relay.send(
    makeEnvelope({
      type: 'session.resume_new',
      userId: ids.userId,
      deviceId: ids.deviceId,
      sessionId: parentId,
      payload,
    }),
  );
}

/** Ack the daemon's chained announce with a relay-minted child id; returns the announce payload. */
async function ackChained(
  relay: FakeRelay,
  ids: { userId: string; deviceId: string },
  childId: string,
): Promise<{ clientRef: string; parentSessionId: string }> {
  const announce = await relay.waitForFrame((e) => e.type === 'session.chained');
  const payload = announce.payload as { clientRef: string; parentSessionId: string };
  relay.send(
    makeEnvelope({
      type: 'session.chained',
      userId: ids.userId,
      deviceId: ids.deviceId,
      sessionId: childId,
      payload: { clientRef: payload.clientRef, parentSessionId: payload.parentSessionId },
    }),
  );
  return payload;
}

/**
 * Barrier + negative assert: the daemon chains inbound handleFrame calls per socket, and the drop
 * guards under test run synchronously to completion (cleartext daemon: no await before the early
 * returns) — so by the time the echo round-trip completes, a frame the drop would have produced has
 * either arrived or never will. No timing wait.
 */
async function expectNoFrame(
  relay: FakeRelay,
  ids: { userId: string; deviceId: string },
  predicate: (e: Envelope) => boolean,
): Promise<void> {
  let observed = false;
  relay.waitForFrame(predicate).then(
    () => {
      observed = true;
    },
    // Expected: nothing arrives, so the peek eventually times out — never an unhandled rejection.
    () => undefined,
  );
  relay.send(
    makeEnvelope({
      type: 'echo',
      userId: ids.userId,
      deviceId: ids.deviceId,
      payload: { text: 'barrier' },
    }),
  );
  await relay.waitForFrame((e) => e.type === 'echo.reply');
  expect(observed).toBe(false);
}

describe('daemon resume-as-new (session-identity T8)', () => {
  it("the child inherits the parent's workspace identity — branch and repo (branch-visibility T3)", async () => {
    const ids = await startDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'done' }], { sessionId: 'sdk-branchy' }),
      {
        worktreeManager: {
          ensureWorktree: (sessionId: string) =>
            Promise.resolve({ path: `/worktrees/${sessionId}`, branch: `telecode/${sessionId}` }),
        },
        defaultRepoPath: '/repos/app',
      },
    );
    const { relay } = ids;
    const parentId = randomUUID();
    const childId = randomUUID();
    await launchToEnd(relay, ids, parentId, 'build the feature');
    // The parent's own identity carries its worktree branch (T1) — consume it so the child's is next.
    const parentMeta = sessionMetaPayloadSchema.parse(
      (await relay.waitForFrame(ofType('session.meta', parentId))).payload,
    );
    expect(parentMeta.branch).toBe(`telecode/${parentId}`);

    sendResumeNew(relay, ids, parentId, { prompt: 'continue it' });
    await ackChained(relay, ids, childId);

    // The child runs in the parent's worktree, so it IS on the parent's branch and repo — the sealed
    // identity must say so (a worktree cwd alone can never name either).
    const childMeta = sessionMetaPayloadSchema.parse(
      (await relay.waitForFrame(ofType('session.meta', childId))).payload,
    );
    expect(childMeta.branch).toBe(`telecode/${parentId}`);
    expect(childMeta.repo).toBe('app');
    expect(childMeta.cwd).toBe(`/worktrees/${parentId}`);
  });

  it('forks-and-resumes a done launched parent into a linked child (clientRef → child started)', async () => {
    const runCalls: RunCall[] = [];
    const ids = await startDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'done work' }], {
        sessionId: 'sdk-parent',
        onRun: (call) => runCalls.push(call),
      }),
    );
    const { relay } = ids;
    const parentId = randomUUID();
    const childId = randomUUID();
    await launchToEnd(relay, ids, parentId, 'build the feature');

    sendResumeNew(relay, ids, parentId, { prompt: 'now add tests', clientRef: 'browser-ref-1' });

    // The child is minted via the EXISTING chained machinery: ids-only announce, linked to the parent.
    const announce = await ackChained(relay, ids, childId);
    expect(announce.parentSessionId).toBe(parentId);

    // The acting browser can navigate: the child's started frame echoes ITS clientRef.
    const started = await relay.waitForFrame(ofType('session.started', childId));
    expect(started.payload).toMatchObject({ clientRef: 'browser-ref-1' });

    // The child's sealed identity: a title derived from the prompt (cleartext daemon here).
    const meta = sessionMetaPayloadSchema.parse(
      (await relay.waitForFrame(ofType('session.meta', childId))).payload,
    );
    expect(meta.title).toBe('now add tests');

    // The conversation was FORK-resumed from the parent's SDK id with the prompt as the next turn.
    await relay.waitForFrame(ofType('session.ended', childId));
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]).toMatchObject({
      prompt: 'now add tests',
      resume: 'sdk-parent',
      forkSession: true,
    });
  });

  it('fresh-launches (no resume) when the parent has no resumable conversation (needs_restart)', async () => {
    const runCalls: RunCall[] = [];
    // An adapter that never reports an SDK session id — the parent ends with nothing to resume.
    const adapter: AgentAdapter = {
      async run(prompt, { onEvent, resume, forkSession, cwd }) {
        runCalls.push({
          prompt,
          ...(resume !== undefined ? { resume } : {}),
          ...(forkSession !== undefined ? { forkSession } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
        });
        onEvent({ type: 'message', text: 'ran once' });
        return { intercepted: [], allowed: [], denied: [] };
      },
    };
    const ids = await startDaemon(adapter);
    const { relay } = ids;
    const parentId = randomUUID();
    const childId = randomUUID();
    await launchToEnd(relay, ids, parentId, 'first run');

    // A follow-up can't resume → the daemon honestly reports needs_restart (T4 behavior).
    relay.send(
      makeEnvelope({
        type: 'user.message',
        userId: ids.userId,
        deviceId: ids.deviceId,
        sessionId: parentId,
        payload: { text: 'hello?' },
      }),
    );
    const restart = await relay.waitForFrame(ofType('session.ended', parentId));
    expect(restart.payload).toMatchObject({ status: 'needs_restart' });

    // Resume-as-new is the way out: a linked child, launched FRESH (no resume id exists).
    sendResumeNew(relay, ids, parentId, { prompt: 'start over from here' });
    const announce = await ackChained(relay, ids, childId);
    expect(announce.parentSessionId).toBe(parentId);
    await relay.waitForFrame(ofType('session.ended', childId));
    const childRun = runCalls.at(-1);
    expect(childRun).toMatchObject({ prompt: 'start over from here' });
    expect(childRun?.resume).toBeUndefined();
    expect(childRun?.forkSession).toBeUndefined();
  });

  it('serves a parent only the relay remembers (daemon restarted without it): fresh linked child', async () => {
    const runCalls: RunCall[] = [];
    const ids = await startDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'fresh child' }], {
        sessionId: 'sdk-fresh',
        onRun: (call) => runCalls.push(call),
      }),
    );
    const { relay } = ids;
    const unknownParent = randomUUID();
    const childId = randomUUID();

    sendResumeNew(relay, ids, unknownParent, { prompt: 'continue the lost session' });
    const announce = await ackChained(relay, ids, childId);
    expect(announce.parentSessionId).toBe(unknownParent);
    await relay.waitForFrame(ofType('session.ended', childId));
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({ prompt: 'continue the lost session' });
    expect(runCalls[0]?.resume).toBeUndefined();
  });

  it('drops a resume_new for a session it knows to be still going (no child, run untouched)', async () => {
    const ids = await startDaemon(
      // A gated tool keeps the session awaiting_input — stably non-terminal.
      createFakeAgentAdapter([{ type: 'tool_use', toolName: 'Write', input: { path: 'a' } }], {
        sessionId: 'sdk-live',
      }),
    );
    const { relay } = ids;
    const parentId = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId: ids.userId,
        deviceId: ids.deviceId,
        sessionId: parentId,
        payload: { prompt: 'long task' },
      }),
    );
    await relay.waitForFrame(ofType('agent.permission_request', parentId));

    sendResumeNew(relay, ids, parentId, { prompt: 'fork it anyway' });
    await expectNoFrame(relay, ids, (e) => e.type === 'session.chained');
  });

  it('drops a resume_new with an invalid payload (empty prompt)', async () => {
    const ids = await startDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'x' }], { sessionId: 'sdk-x' }),
    );
    const { relay } = ids;
    const parentId = randomUUID();
    await launchToEnd(relay, ids, parentId, 'a task');

    sendResumeNew(relay, ids, parentId, { prompt: '' });
    await expectNoFrame(relay, ids, (e) => e.type === 'session.chained');
  });

  it('opens a BOX-SEALED resume_new (AD-17: sealed like a launch, never under the parent key)', async () => {
    const runCalls: RunCall[] = [];
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const ids = mkE2eIds();
    const { daemon, relay } = await startE2eDaemon({
      ids,
      daemonKeyPair: daemonKp,
      agentAdapter: createFakeAgentAdapter([{ type: 'message', text: 'sealed work' }], {
        sessionId: 'sdk-sealed',
        onRun: (call) => runCalls.push(call),
      }),
    });
    daemons.push(daemon);
    relays.push(relay);
    const childId = randomUUID();

    // Run the parent to its end through the sealed launch path.
    await sendSealedLaunch(relay, ids, daemonKp, browserKp, { prompt: 'sealed parent task' });
    await relay.waitForFrame(ofType('session.ended', ids.sessionId));

    // The resume frame is sealed to the DAEMON (launch-style), not under any session content key.
    const sealed = await sealEnvelopePayload(
      { prompt: 'sealed continuation', clientRef: 'ref-sealed' },
      daemonKp.publicKey,
      browserKp.privateKey,
    );
    relay.send(
      makeEnvelope({
        type: 'session.resume_new',
        userId: ids.userId,
        deviceId: ids.deviceId,
        sessionId: ids.sessionId,
        senderPublicKey: encodeKey(browserKp.publicKey),
        payload: sealed.payload,
        nonce: sealed.nonce,
      }),
    );
    await ackChained(relay, ids, childId);
    // The child's content key is delivered to the REQUESTING browser's pubkey BEFORE started — the
    // acting browser must be able to decrypt the clientRef to pair + navigate.
    const keyFrame = await relay.waitForFrame(ofType('session.key', childId));
    const started = await relay.waitForFrame(ofType('session.started', childId));

    // The daemon opened the box: the PLAINTEXT prompt reached the adapter as a fork of the parent —
    // and the child's own frames are E2E (opaque string payloads), like any launched session's.
    expect(runCalls.at(-1)).toMatchObject({
      prompt: 'sealed continuation',
      resume: 'sdk-sealed',
      forkSession: true,
    });
    expect(typeof started.payload).toBe('string');
    expect(started.nonce).not.toBe('');
    const childKey = await unwrapContentKey(
      { payload: keyFrame.payload, nonce: keyFrame.nonce },
      daemonKp.publicKey,
      browserKp.privateKey,
    );
    expect(
      await decryptWithContentKey({ payload: started.payload, nonce: started.nonce }, childKey),
    ).toEqual({ clientRef: 'ref-sealed' });
  });

  it('forks an ADOPTED terminal parent from its recorded Claude session id', async () => {
    const runCalls: RunCall[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'telecode-resume-adopt-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: createFakeAgentAdapter([{ type: 'message', text: 'forked from adopted' }], {
        sessionId: 'sdk-adopt-child',
        onRun: (call) => runCalls.push(call),
      }),
      adopt: { socketPath, ackTimeoutMs: 2000, configPath: join(dir, 'adopt-config.json') },
      logger: silent,
    });
    daemons.push(daemon);
    await daemon.start();
    try {
      const claudeSessionId = 'claude-adopted-1';
      const parentId = randomUUID();
      const childId = randomUUID();
      // Adopt via the hook bridge (PreToolUse announces; ack mints the parent row) …
      const first = hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: claudeSessionId,
        cwd: '/repo',
        tool_name: 'Read',
        tool_input: {},
      });
      const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
      relay.send(
        makeEnvelope({
          type: 'session.adopted',
          userId,
          deviceId,
          sessionId: parentId,
          payload: { clientRef: (announce.payload as { clientRef: string }).clientRef },
        }),
      );
      await first;
      // … and end it (SessionEnd hook → the adopted session is terminal).
      await hookRpc(socketPath, {
        hook_event_name: 'SessionEnd',
        session_id: claudeSessionId,
        cwd: '/repo',
      });
      await relay.waitForFrame(ofType('session.ended', parentId));

      const ids = { userId, deviceId };
      sendResumeNew(relay, ids, parentId, { prompt: 'continue the adopted work' });
      const chained = await ackChained(relay, ids, childId);
      expect(chained.parentSessionId).toBe(parentId);
      await relay.waitForFrame(ofType('session.ended', childId));

      // The adopted parent's Claude id is the fork's resume source (AD-17: record.claudeSessionId
      // covers launched AND adopted parents) — and the fork runs in the parent's cwd.
      expect(runCalls.at(-1)).toMatchObject({
        prompt: 'continue the adopted work',
        resume: claudeSessionId,
        forkSession: true,
        cwd: '/repo',
      });

      // The inherited cwd is PERSISTED on the child, not first-turn-only: a later follow-up to the
      // child still runs in it.
      relay.send(
        makeEnvelope({
          type: 'user.message',
          userId,
          deviceId,
          sessionId: childId,
          payload: { text: 'and keep going' },
        }),
      );
      await relay.waitForFrame(ofType('session.ended', childId));
      expect(runCalls.at(-1)).toMatchObject({ prompt: 'and keep going', cwd: '/repo' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('continuation permission mode (continuation-permission-mode fix)', () => {
  it('starts the child in the browser-requested mode — bypass runs unattended', async () => {
    // The user's saved default is bypass, but the PARENT chain ran in approve mode: the child is a
    // NEW session, so the explicit mode on resume_new wins over inheritance (the reported bug: a
    // continuation kept asking although Settings said bypass). The adapter attempts Bash only on
    // the CHILD's prompt — the parent's prompt never triggers a tool; it exists purely to reach
    // session.ended so resume_new has a terminal target (parent-mode behavior is NOT under test).
    const adapter: AgentAdapter = {
      async run(prompt, { canUseTool, onEvent }) {
        if (prompt === 'continue it hands-off') {
          const decision = await canUseTool({
            toolName: 'Bash',
            input: { command: 'pnpm test' },
          });
          if (decision.behavior === 'allow') {
            onEvent({ type: 'tool_use', toolName: 'Bash', input: { command: 'pnpm test' } });
          }
        }
        onEvent({ type: 'message', text: 'done' });
        return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-mode-child' };
      },
    };
    const ids = await startDaemon(adapter);
    const { relay } = ids;
    const parentId = randomUUID();
    const childId = randomUUID();
    await launchToEnd(relay, ids, parentId, 'build the feature');

    sendResumeNew(relay, ids, parentId, {
      prompt: 'continue it hands-off',
      permissionMode: 'bypassPermissions',
    });
    await ackChained(relay, ids, childId);
    // The child's Bash runs WITHOUT a gate; the turn completes on its own.
    const ended = await relay.waitForFrame(ofType('session.ended', childId));
    expect(ended.status).toBe('done');
    await expectNoFrame(relay, ids, ofType('agent.permission_request', childId));
  });

  it('inherits the parent mode when the browser sends none (older webs)', async () => {
    // Parent launched in bypass; a mode-less resume_new keeps the child unattended too.
    const ids = await startDaemon(
      createFakeAgentAdapter(
        [
          { type: 'tool_use', toolName: 'Bash', input: { command: 'echo hi' } },
          { type: 'message', text: 'done' },
        ],
        { sessionId: 'sdk-mode-inherit' },
      ),
    );
    const { relay } = ids;
    const parentId = randomUUID();
    const childId = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId: ids.userId,
        deviceId: ids.deviceId,
        sessionId: parentId,
        payload: { prompt: 'parent task', permissionMode: 'bypassPermissions' },
      }),
    );
    await relay.waitForFrame(ofType('session.ended', parentId));

    sendResumeNew(relay, ids, parentId, { prompt: 'keep going' });
    await ackChained(relay, ids, childId);
    const ended = await relay.waitForFrame(ofType('session.ended', childId));
    expect(ended.status).toBe('done');
    await expectNoFrame(relay, ids, ofType('agent.permission_request', childId));
  });
});

describe('one-step takeover of a live adopted session (adopted-takeover T3)', () => {
  /** Start an adopt-capable daemon with a run-capturing adapter; returns the harness pieces. */
  async function startTakeoverDaemon(adapter: AgentAdapter): Promise<{
    relay: FakeRelay;
    ids: { userId: string; deviceId: string };
    socketPath: string;
    dir: string;
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'telecode-takeover-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: adapter,
      adopt: { socketPath, ackTimeoutMs: 2000, configPath: join(dir, 'adopt-config.json') },
      logger: silent,
    });
    daemons.push(daemon);
    await daemon.start();
    return { relay, ids: { userId, deviceId }, socketPath, dir };
  }

  /** Adopt a Claude session and park it between turns (Stop without a question → waiting_local). */
  async function adoptAndPark(
    relay: FakeRelay,
    ids: { userId: string; deviceId: string },
    socketPath: string,
    dir: string,
    claudeSessionId: string,
    parentId: string,
  ): Promise<void> {
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: claudeSessionId,
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: {},
    });
    const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
    relay.send(
      makeEnvelope({
        type: 'session.adopted',
        userId: ids.userId,
        deviceId: ids.deviceId,
        sessionId: parentId,
        payload: { clientRef: (announce.payload as { clientRef: string }).clientRef },
      }),
    );
    await first;
    const transcriptPath = join(dir, `park-${claudeSessionId}.jsonl`);
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Docs are updated.' }] },
      })}\n`,
    );
    await hookRpc(socketPath, {
      hook_event_name: 'Stop',
      session_id: claudeSessionId,
      cwd: '/repo',
      transcript_path: transcriptPath,
      last_assistant_message: 'Docs are updated. The deploy is green.',
    });
    await relay.waitForFrame(
      (e) =>
        e.type === 'session.status' && e.session_id === parentId && e.status === 'waiting_local',
    );
  }

  it('takes over a between-turns adopted parent: forks its conversation and retires the mirror', async () => {
    const runCalls: RunCall[] = [];
    const { relay, ids, socketPath, dir } = await startTakeoverDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'took over' }], {
        sessionId: 'sdk-takeover-child',
        onRun: (call) => runCalls.push(call),
      }),
    );
    try {
      const claudeSessionId = 'claude-live-1';
      const parentId = randomUUID();
      const childId = randomUUID();
      await adoptAndPark(relay, ids, socketPath, dir, claudeSessionId, parentId);

      sendResumeNew(relay, ids, parentId, { prompt: 'now implement phase 7' });
      const chained = await ackChained(relay, ids, childId);
      expect(chained.parentSessionId).toBe(parentId);

      // The conversation migrates: the parent mirror is retired PROMPTLY (before the child's long
      // turn settles), exactly like the question-handover path.
      const parentEnded = await relay.waitForFrame(ofType('session.ended', parentId));
      expect(parentEnded.status).toBe('done');

      // The child fork-resumes the EXTERNAL conversation with the typed instruction as its turn,
      // in the parent's cwd — never writing into the live external transcript (forkSession).
      await relay.waitForFrame(ofType('session.ended', childId));
      expect(runCalls.at(-1)).toMatchObject({
        prompt: 'now implement phase 7',
        resume: claudeSessionId,
        forkSession: true,
        cwd: '/repo',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still refuses a mid-turn adopted parent (running) — takeover is a between-turns move', async () => {
    const { relay, ids, socketPath, dir } = await startTakeoverDaemon(createFakeAgentAdapter([]));
    try {
      const claudeSessionId = 'claude-live-2';
      const parentId = randomUUID();
      // Adopt via a tool call and leave it RUNNING (no Stop) — the agent is mid-turn locally.
      const first = hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: claudeSessionId,
        cwd: '/repo',
        tool_name: 'Read',
        tool_input: {},
      });
      const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
      relay.send(
        makeEnvelope({
          type: 'session.adopted',
          userId: ids.userId,
          deviceId: ids.deviceId,
          sessionId: parentId,
          payload: { clientRef: (announce.payload as { clientRef: string }).clientRef },
        }),
      );
      await first;

      sendResumeNew(relay, ids, parentId, { prompt: 'fork it anyway' });
      await expectNoFrame(relay, ids, (e) => e.type === 'session.chained');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a context-seeded fresh launch when the external conversation cannot resume', async () => {
    const runCalls: RunCall[] = [];
    // Resuming an externally-created conversation fails (SDK cannot pick it up) — the takeover must
    // still land, seeded with the mirrored context instead of starting cold.
    const adapter: AgentAdapter = {
      async run(prompt, { onEvent, resume, forkSession, cwd }) {
        runCalls.push({
          prompt,
          ...(resume !== undefined ? { resume } : {}),
          ...(forkSession !== undefined ? { forkSession } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
        });
        if (resume !== undefined) {
          throw new Error('cannot resume an externally-created conversation');
        }
        onEvent({ type: 'message', text: 'fresh but oriented' });
        return { intercepted: [], allowed: [], denied: [] };
      },
    };
    const { relay, ids, socketPath, dir } = await startTakeoverDaemon(adapter);
    try {
      const claudeSessionId = 'claude-live-3';
      const parentId = randomUUID();
      const childId = randomUUID();
      await adoptAndPark(relay, ids, socketPath, dir, claudeSessionId, parentId);

      sendResumeNew(relay, ids, parentId, { prompt: 'polish the error copy' });
      await ackChained(relay, ids, childId);
      // The fallback run still lands the child cleanly — a completed turn, not an error.
      expect((await relay.waitForFrame(ofType('session.ended', childId))).status).toBe('done');

      // First call tried the fork-resume; the fallback ran fresh, seeded with the mirrored context
      // (summary of where the session left off) AND the user's instruction — never the bare prompt.
      expect(runCalls.at(-2)).toMatchObject({ resume: claudeSessionId, forkSession: true });
      const fallback = runCalls.at(-1);
      expect(fallback?.resume).toBeUndefined();
      expect(fallback?.prompt).toContain('continuing a previous session');
      expect(fallback?.prompt).toContain('polish the error copy');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the parent LIVE when the user resumes locally during the takeover mint (race)', async () => {
    const { relay, ids, socketPath, dir } = await startTakeoverDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'forked anyway' }], {
        sessionId: 'sdk-race-child',
      }),
    );
    try {
      const claudeSessionId = 'claude-live-race';
      const parentId = randomUUID();
      const childId = randomUUID();
      await adoptAndPark(relay, ids, socketPath, dir, claudeSessionId, parentId);

      // The takeover starts… and while the daemon awaits the relay's chained ack, the user types at
      // the terminal (UserPromptSubmit flips the parent back to running — a frame we wait for, so
      // the flip deterministically lands before we release the mint below).
      sendResumeNew(relay, ids, parentId, { prompt: 'take it over' });
      const announce = await relay.waitForFrame((e) => e.type === 'session.chained');
      await hookRpc(socketPath, {
        hook_event_name: 'UserPromptSubmit',
        session_id: claudeSessionId,
        cwd: '/repo',
        prompt: 'actually, one more local tweak',
      });
      await relay.waitForFrame(
        (e) => e.type === 'session.status' && e.session_id === parentId && e.status === 'running',
      );
      relay.send(
        makeEnvelope({
          type: 'session.chained',
          userId: ids.userId,
          deviceId: ids.deviceId,
          sessionId: childId,
          payload: {
            clientRef: (announce.payload as { clientRef: string }).clientRef,
            parentSessionId: parentId,
          },
        }),
      );

      // The child still runs (an honest FORK, linked) — but the LIVE parent is never severed.
      await relay.waitForFrame(ofType('session.ended', childId));
      await expectNoFrame(
        relay,
        ids,
        (e) => e.type === 'session.ended' && e.session_id === parentId,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never resurrects a retired parent: later local Stops keep mirroring but the row stays done', async () => {
    const { relay, ids, socketPath, dir } = await startTakeoverDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'child ran' }], {
        sessionId: 'sdk-no-resurrect',
      }),
    );
    try {
      const claudeSessionId = 'claude-live-4';
      const parentId = randomUUID();
      const childId = randomUUID();
      await adoptAndPark(relay, ids, socketPath, dir, claudeSessionId, parentId);
      sendResumeNew(relay, ids, parentId, { prompt: 'take it from here' });
      await ackChained(relay, ids, childId);
      await relay.waitForFrame(ofType('session.ended', parentId));

      // The user keeps typing in the STILL-LIVE local terminal session: another turn ends there.
      const transcriptPath = join(dir, 'post-takeover.jsonl');
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'more local work' }] },
        })}\n`,
      );
      await hookRpc(socketPath, {
        hook_event_name: 'Stop',
        session_id: claudeSessionId,
        cwd: '/repo',
        transcript_path: transcriptPath,
        last_assistant_message: 'more local work',
      });

      // No waiting_local report may follow for the retired parent — its story is over.
      await expectNoFrame(
        relay,
        ids,
        (e) =>
          e.type === 'session.status' && e.session_id === parentId && e.status === 'waiting_local',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resume-as-new variants: every terminal parent status is continuable (T9)', () => {
  it.each([
    { endReason: undefined, endedAs: 'done' },
    { endReason: 'turn_limit' as const, endedAs: 'turn_limit' },
    { endReason: 'execution_error' as const, endedAs: 'error' },
  ])('a parent ended as $endedAs forks into a linked child', async ({ endReason, endedAs }) => {
    const runCalls: RunCall[] = [];
    const ids = await startDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'ran' }], {
        sessionId: `sdk-${endedAs}`,
        ...(endReason !== undefined ? { endReason } : {}),
        onRun: (call) => runCalls.push(call),
      }),
    );
    const { relay } = ids;
    const parentId = randomUUID();
    const childId = randomUUID();
    const ended = await launchToEnd(relay, ids, parentId, `end as ${endedAs}`);
    expect(ended.payload).toMatchObject({ status: endedAs });

    sendResumeNew(relay, ids, parentId, { prompt: `continue after ${endedAs}` });
    const announce = await ackChained(relay, ids, childId);
    expect(announce.parentSessionId).toBe(parentId);
    await relay.waitForFrame(ofType('session.ended', childId));
    expect(runCalls.at(-1)).toMatchObject({
      prompt: `continue after ${endedAs}`,
      resume: `sdk-${endedAs}`,
      forkSession: true,
    });
  });
});

/**
 * Fork onto a chosen branch (branch-actions T5): either branch field on the resume_new payload
 * gives the child its OWN worktree — cut from the chosen base (default: the parent's branch, so
 * the fork continues its code state) with the chosen name (default: the auto slug) — instead of
 * inheriting the parent's. Real git repos + the real worktree manager; only the agent is fake.
 */
describe('daemon resume-as-new onto a chosen branch (branch-actions T5)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function makeRepo(): Promise<string> {
    const dir = await tempDir('telecode-fork-repo-');
    await runGitCmd(dir, ['init', '-q', '-b', 'main']);
    await runGitCmd(dir, ['config', 'user.email', 'test@telecode.local']);
    await runGitCmd(dir, ['config', 'user.name', 'telecode-test']);
    await writeFile(join(dir, 'README.md'), '# repo\n');
    await runGitCmd(dir, ['add', '.']);
    await runGitCmd(dir, ['commit', '-qm', 'init']);
    // A diverged base a fork can choose: feat/base carries a file main does not.
    await runGitCmd(dir, ['checkout', '-qb', 'feat/base']);
    await writeFile(join(dir, 'base-only.txt'), 'on feat/base\n');
    await runGitCmd(dir, ['add', '.']);
    await runGitCmd(dir, ['commit', '-qm', 'base work']);
    await runGitCmd(dir, ['checkout', '-q', 'main']);
    return dir;
  }

  interface ForkHarness {
    relay: FakeRelay;
    ids: { userId: string; deviceId: string };
    repoPath: string;
    worktreesRoot: string;
    runCalls: RunCall[];
  }

  async function startForkHarness(): Promise<ForkHarness> {
    const repoPath = await makeRepo();
    const worktreesRoot = await tempDir('telecode-fork-worktrees-');
    const runCalls: RunCall[] = [];
    const adapter: AgentAdapter = {
      async run(prompt, opts) {
        runCalls.push({
          prompt,
          ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
          ...(opts.forkSession !== undefined ? { forkSession: opts.forkSession } : {}),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        });
        opts.onEvent({ type: 'message', text: 'done' });
        return { intercepted: [], allowed: [], denied: [], sessionId: `sdk-${runCalls.length}` };
      },
    };
    const ids = await startDaemon(adapter, {
      worktreeManager: createGitWorktreeManager({ worktreesRoot, logger: silent }),
      defaultRepoPath: repoPath,
    });
    return { relay: ids.relay, ids, repoPath, worktreesRoot, runCalls };
  }

  it('cuts the child a fresh worktree from the CHOSEN base with the chosen name', async () => {
    const h = await startForkHarness();
    const parentId = randomUUID();
    await launchToEnd(h.relay, h.ids, parentId, 'parent work');

    const childId = randomUUID();
    sendResumeNew(h.relay, h.ids, parentId, {
      prompt: 'continue over there',
      baseBranch: 'feat/base',
      branchName: 'feat/continued',
    });
    await ackChained(h.relay, h.ids, childId);
    await h.relay.waitForFrame(ofType('session.ended', childId));

    // The child ran in its OWN worktree — not the parent's.
    const childCwd = join(h.worktreesRoot, childId);
    expect(h.runCalls.at(-1)?.cwd).toBe(childCwd);
    expect(h.runCalls.at(-1)?.forkSession).toBe(true);
    // Cut from feat/base (its file is present) onto the chosen name.
    await access(join(childCwd, 'base-only.txt'));
    const head = await runGitCmd(childCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(head.trim()).toBe('feat/continued');
    // The parent's worktree survives untouched.
    await access(join(h.worktreesRoot, parentId));
    // The child's sealed identity reports ITS branch and cwd (never the parent's).
    const childMeta = sessionMetaPayloadSchema.parse(
      (
        await h.relay.waitForFrame((e) => {
          if (e.type !== 'session.meta' || e.session_id !== childId) return false;
          const parsed = sessionMetaPayloadSchema.safeParse(e.payload);
          return parsed.success && parsed.data.branch === 'feat/continued';
        })
      ).payload,
    );
    expect(childMeta.cwd).toBe(childCwd);
  });

  it('defaults the base to the PARENT branch — the fork continues its code state', async () => {
    const h = await startForkHarness();
    const parentId = randomUUID();
    await launchToEnd(h.relay, h.ids, parentId, 'parent work');
    // Work committed on the parent's branch after its run — the fork must start from it.
    const parentCwd = join(h.worktreesRoot, parentId);
    await writeFile(join(parentCwd, 'parent-work.txt'), 'committed on the parent branch\n');
    await runGitCmd(parentCwd, ['add', '.']);
    await runGitCmd(parentCwd, ['commit', '-qm', 'parent work']);

    const childId = randomUUID();
    sendResumeNew(h.relay, h.ids, parentId, {
      prompt: 'continue on a named branch',
      branchName: 'feat/from-parent',
    });
    await ackChained(h.relay, h.ids, childId);
    await h.relay.waitForFrame(ofType('session.ended', childId));

    const childCwd = join(h.worktreesRoot, childId);
    await access(join(childCwd, 'parent-work.txt')); // the parent's committed state came along
    const head = await runGitCmd(childCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(head.trim()).toBe('feat/from-parent');
  });

  it('fails the child cleanly (coded, verbatim) when the chosen name already exists', async () => {
    const h = await startForkHarness();
    await runGitCmd(h.repoPath, ['branch', 'taken']);
    const parentId = randomUUID();
    await launchToEnd(h.relay, h.ids, parentId, 'parent work');

    const childId = randomUUID();
    sendResumeNew(h.relay, h.ids, parentId, {
      prompt: 'continue onto a taken name',
      branchName: 'taken',
    });
    await ackChained(h.relay, h.ids, childId);
    const ended = await h.relay.waitForFrame(ofType('session.ended', childId));
    expect(ended.payload).toMatchObject({
      status: 'error',
      error: 'branch already exists: taken',
    });
    // No half-made workspace for the failed child.
    await expect(access(join(h.worktreesRoot, childId))).rejects.toThrow();
  });
});
