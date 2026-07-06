import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEnvelope, sessionHistoryPayloadSchema, type Envelope } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter, type AgentEvent } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createSessionStore } from './sessions/session-store';
import { type WorktreeManager } from './sessions/worktree-manager';

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

describe('daemon restart persistence: resume ids + follow-ups (session-identity T4)', () => {
  /** An adapter that records the `resume` id each run was called with (proves cross-restart resume). */
  function recordingAdapter(sdkSessionId: string, resumes: (string | undefined)[]): AgentAdapter {
    return createFakeAgentAdapter([{ type: 'message', text: 'continued' }], {
      sessionId: sdkSessionId,
      onRun: ({ resume }) => resumes.push(resume),
    });
  }

  async function startWith(
    userId: string,
    deviceId: string,
    dir: string,
    adapter: AgentAdapter,
    extras: { worktreeManager?: WorktreeManager; defaultRepoPath?: string } = {},
  ): Promise<FakeRelay> {
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: adapter,
      sessionStore: createSessionStore({ dir }),
      logger: silent,
      ...extras,
    });
    daemons.push(daemon);
    await daemon.start();
    return relay;
  }

  it('resumes a launched session on a follow-up AFTER a restart (no more silently dropped follow-ups)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sid = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'telecode-t4-'));
    dirs.push(dir);
    const resumesA: (string | undefined)[] = [];
    const resumesB: (string | undefined)[] = [];

    // Daemon A: launch + complete a turn — the SDK conversation id is captured and persisted.
    const relayA = await startWith(userId, deviceId, dir, recordingAdapter('sdk-resume', resumesA));
    relayA.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sid,
        payload: { prompt: 'first' },
      }),
    );
    await relayA.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sid);
    expect(resumesA).toEqual([undefined]); // the launch turn had no resume
    // Wait until the resume id is on disk (the persist is coalesced/async) — this is the real barrier.
    await vi.waitFor(
      async () => {
        const persisted = (await createSessionStore({ dir }).loadAll()).get(sid);
        expect(persisted?.claudeSessionId).toBe('sdk-resume');
      },
      { timeout: 5000, interval: 50 },
    );

    // Daemon B: a fresh process on the same store. A follow-up must RESUME the same conversation.
    const relayB = await startWith(userId, deviceId, dir, recordingAdapter('sdk-resume', resumesB));
    relayB.send(
      makeEnvelope({
        type: 'user.message',
        userId,
        deviceId,
        sessionId: sid,
        payload: { text: 'keep going' },
      }),
    );
    const ended = await relayB.waitForFrame(
      (e) => e.type === 'session.ended' && e.session_id === sid,
    );
    expect(ended.status).toBe('done'); // the follow-up ran a real turn (not a drop, not needs_restart)
    expect(resumesB).toEqual(['sdk-resume']); // it resumed the SAME persisted conversation id
  });

  it('reuses the restored worktree cwd for a follow-up after a restart', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sid = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'telecode-t4-cwd-'));
    dirs.push(dir);
    const runsB: { cwd?: string }[] = [];
    // A minimal worktree manager: the cwd contract needs the PATH, not real git plumbing.
    const worktreeManager: WorktreeManager = {
      ensureWorktree: (sessionId) =>
        Promise.resolve({ path: `/worktrees/${sessionId}`, branch: `telecode/${sessionId}` }),
    };

    // Daemon A: launch in a worktree so cwd is set + persisted with the resume id.
    const relayA = await startWith(
      userId,
      deviceId,
      dir,
      createFakeAgentAdapter([{ type: 'message', text: 'ok' }], { sessionId: 'sdk-cwd' }),
      { worktreeManager, defaultRepoPath: '/repos/app' },
    );
    relayA.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sid,
        payload: { prompt: 'first' },
      }),
    );
    await relayA.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sid);
    await vi.waitFor(
      async () => {
        expect((await createSessionStore({ dir }).loadAll()).get(sid)?.cwd).toBe(
          `/worktrees/${sid}`,
        );
      },
      { timeout: 5000, interval: 50 },
    );

    // Daemon B: a fresh process (no worktree manager). The follow-up must run in the RESTORED cwd.
    const relayB = await startWith(
      userId,
      deviceId,
      dir,
      createFakeAgentAdapter([{ type: 'message', text: 'more' }], {
        sessionId: 'sdk-cwd',
        onRun: ({ cwd }) => runsB.push({ ...(cwd !== undefined ? { cwd } : {}) }),
      }),
    );
    relayB.send(
      makeEnvelope({
        type: 'user.message',
        userId,
        deviceId,
        sessionId: sid,
        payload: { text: 'keep going' },
      }),
    );
    await relayB.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sid);
    expect(runsB).toEqual([{ cwd: `/worktrees/${sid}` }]);
  });

  it('answers a follow-up on a HELD launched session that lost its resume id with needs_restart', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sid = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'telecode-t4-nr-'));
    dirs.push(dir);
    // An adapter that reports NO SDK session id, so the launched turn persists with no resume id.
    const noResumeAdapter: AgentAdapter = {
      run: (_prompt, { onEvent }) => {
        onEvent({ type: 'message', text: 'done' });
        return Promise.resolve({ intercepted: [], allowed: [], denied: [] });
      },
    };

    // Daemon A: launch + complete a turn. The record persists (origin launched) but WITHOUT a resume id.
    const relayA = await startWith(userId, deviceId, dir, noResumeAdapter);
    relayA.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sid,
        payload: { prompt: 'first' },
      }),
    );
    await relayA.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sid);
    await vi.waitFor(
      async () => {
        // The record is on disk (held) but with no resume id captured.
        const persisted = (await createSessionStore({ dir }).loadAll()).get(sid);
        expect(persisted).toBeDefined();
        expect(persisted?.claudeSessionId).toBeUndefined();
      },
      { timeout: 5000, interval: 50 },
    );

    // Daemon B: a fresh process that RESTORES the record but has no resume id for it. A follow-up must
    // report needs_restart honestly — not a silent drop, not a phantom.
    const relayB = await startWith(userId, deviceId, dir, noResumeAdapter);
    relayB.send(
      makeEnvelope({
        type: 'user.message',
        userId,
        deviceId,
        sessionId: sid,
        payload: { text: 'are you there?' },
      }),
    );
    const ended = await relayB.waitForFrame(
      (e) => e.type === 'session.ended' && e.session_id === sid,
    );
    expect(ended.status).toBe('needs_restart');
  });

  it('drops a follow-up for an id the daemon never held (no phantom needs_restart record)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'telecode-t4-drop-'));
    dirs.push(dir);
    const relay = await startWith(
      userId,
      deviceId,
      dir,
      createFakeAgentAdapter([], { sessionId: 'x' }),
    );
    const sid = randomUUID();
    // Send the orphan follow-up, then an echo barrier: on the one in-order socket, a session.ended (if
    // the daemon wrongly emitted one) would arrive BEFORE the echo.reply. Seeing echo.reply first proves
    // the follow-up was dropped, and no session file was written for the never-held id.
    relay.send(
      makeEnvelope({
        type: 'user.message',
        userId,
        deviceId,
        sessionId: sid,
        payload: { text: 'orphan' },
      }),
    );
    relay.send(makeEnvelope({ type: 'echo', userId, deviceId, payload: { text: 'barrier' } }));
    const next = await relay.waitForFrame(
      (e) => e.type === 'echo.reply' || e.type === 'session.ended',
    );
    expect(next.type).toBe('echo.reply');
    expect((await createSessionStore({ dir }).loadAll()).has(sid)).toBe(false);
  });
});
