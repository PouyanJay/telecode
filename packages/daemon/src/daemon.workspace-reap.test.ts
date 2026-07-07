import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  makeEnvelope,
  sessionMetaPayloadSchema,
  workspaceReapStatePayloadSchema,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { type AgentAdapter } from './agent-adapter';
import { hookRpc } from './hook-rpc';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createSessionStore } from './sessions/session-store';
import { createGitWorkspaceReaper } from './sessions/workspace-reaper';
import { createGitWorktreeManager } from './sessions/worktree-manager';

const run = promisify(execFile);
const silent = pino({ level: 'silent' });

/**
 * The reap round-trip (branch-actions T3): the browser's delete flow asks `workspace.reap`, the
 * daemon removes a launched session's worktree + branch and forgets the session, answering
 * `workspace.reap.state` — or refuses with a coded story. Real daemon ↔ in-process fake relay ↔
 * real git; cleartext daemon so the payload shape is assertable (the box-seal path is shared with
 * `repo.branches`, proven by the daemon's crypto tests).
 */
describe('daemon: workspace.reap round-trip (branch-actions T3)', () => {
  const daemons: Daemon[] = [];
  const relays: FakeRelay[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((d) => d.stop()));
    await Promise.all(relays.splice(0).map((r) => r.close()));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function makeRepo(): Promise<string> {
    const dir = await tempDir('telecode-reap-rt-repo-');
    await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', dir, 'config', 'user.name', 'telecode-test']);
    await appendFile(join(dir, 'README.md'), '# repo\n');
    await run('git', ['-C', dir, 'add', '.']);
    await run('git', ['-C', dir, 'commit', '-qm', 'init']);
    return dir;
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** A completed one-turn adapter, or one that holds its turn open until the test releases it. */
  function instantAdapter(): AgentAdapter {
    return {
      async run(_prompt, opts) {
        opts.onEvent({ type: 'message', text: 'done' });
        return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
      },
    };
  }

  async function startHarness(adapter: AgentAdapter): Promise<{
    relay: FakeRelay;
    userId: string;
    deviceId: string;
    storeDir: string;
    worktreesRoot: string;
    repoPath: string;
    launch: (sessionId: string) => void;
    reap: (sessionId: string) => void;
  }> {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const repoPath = await makeRepo();
    const worktreesRoot = await tempDir('telecode-reap-rt-worktrees-');
    const storeDir = await tempDir('telecode-reap-rt-store-');
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: adapter,
      logger: silent,
      worktreeManager: createGitWorktreeManager({ worktreesRoot, logger: silent }),
      defaultRepoPath: repoPath,
      sessionStore: createSessionStore({ dir: storeDir, logger: silent }),
      reapWorkspace: createGitWorkspaceReaper({ worktreesRoot }),
    });
    daemons.push(daemon);
    await daemon.start();
    return {
      relay,
      userId,
      deviceId,
      storeDir,
      worktreesRoot,
      repoPath,
      launch: (sessionId) =>
        relay.send(
          makeEnvelope({
            type: 'session.launch',
            userId,
            deviceId,
            sessionId,
            payload: { prompt: 'reap me later' },
          }),
        ),
      reap: (sessionId) =>
        relay.send(
          makeEnvelope({ type: 'workspace.reap', userId, deviceId, payload: { sessionId } }),
        ),
    };
  }

  async function awaitReapState(relay: FakeRelay, sessionId: string) {
    return workspaceReapStatePayloadSchema.parse(
      (
        await relay.waitForFrame((e) => {
          if (e.type !== 'workspace.reap.state') return false;
          const parsed = workspaceReapStatePayloadSchema.safeParse(e.payload);
          return parsed.success && parsed.data.sessionId === sessionId;
        })
      ).payload,
    );
  }

  it('reaps an ended session: worktree + branch removed, session forgotten on disk', async () => {
    const harness = await startHarness(instantAdapter());
    const sessionId = randomUUID();
    harness.launch(sessionId);
    // The session's OWN branch, from its sealed identity — what the reap must delete (and only it).
    const branch = sessionMetaPayloadSchema.parse(
      (
        await harness.relay.waitForFrame((e) => {
          if (e.type !== 'session.meta' || e.session_id !== sessionId) return false;
          const parsed = sessionMetaPayloadSchema.safeParse(e.payload);
          return parsed.success && parsed.data.branch !== undefined;
        })
      ).payload,
    ).branch;
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');

    harness.reap(sessionId);
    const state = await awaitReapState(harness.relay, sessionId);
    expect(state).toEqual({ sessionId, ok: true });

    expect(await exists(join(harness.worktreesRoot, sessionId))).toBe(false);
    expect(await exists(join(harness.storeDir, `${sessionId}.json`))).toBe(false);
    // The branch itself is gone from the parent repo — not just the directory.
    const branches = await run('git', ['-C', harness.repoPath, 'branch', '--list', branch ?? '']);
    expect(branch).toBeDefined();
    expect(branches.stdout.trim()).toBe('');
    // The daemon no longer holds the session — a subscribe backfills the honest offline fallback.
    harness.relay.send(
      makeEnvelope({
        type: 'session.subscribe',
        userId: harness.userId,
        deviceId: harness.deviceId,
        sessionId,
        payload: {},
      }),
    );
    const history = await harness.relay.waitForFrame((e) => e.type === 'session.history');
    expect(history.payload).toMatchObject({ status: 'offline_paused', entries: [] });
  });

  it('never reaps an ADOPTED session — the checkout is the user’s own (AD-5)', async () => {
    // A real adoption over the hook socket: the daemon announces, the relay acks with a minted id.
    const userId = randomUUID();
    const deviceId = randomUUID();
    const worktreesRoot = await tempDir('telecode-reap-adopt-worktrees-');
    const dir = await tempDir('telecode-reap-adopt-home-');
    const socketPath = join(dir, 'hook.sock');
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: instantAdapter(),
      logger: silent,
      adopt: { socketPath, ackTimeoutMs: 2000 },
      reapWorkspace: createGitWorkspaceReaper({ worktreesRoot }),
    });
    daemons.push(daemon);
    await daemon.start();

    const sessionId = randomUUID();
    const decision = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: 'claude-external-1',
      cwd: dir,
      tool_name: 'Read',
      tool_input: {},
    });
    const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
    relay.send(
      makeEnvelope({
        type: 'session.adopted',
        userId,
        deviceId,
        sessionId,
        payload: { clientRef: (announce.payload as { clientRef: string }).clientRef },
      }),
    );
    await decision; // adoption resolved — the daemon now HOLDS this session as external-origin

    relay.send(makeEnvelope({ type: 'workspace.reap', userId, deviceId, payload: { sessionId } }));
    // A dropped `origin === 'external'` guard would answer ok and delete the user's own checkout;
    // the only acceptable answer is the coded refusal, with the directory untouched.
    expect(await awaitReapState(relay, sessionId)).toEqual({
      sessionId,
      ok: false,
      code: 'not-reapable',
    });
    expect(await exists(dir)).toBe(true);
  });

  it('answers unknown-session for an id it never held', async () => {
    const harness = await startHarness(instantAdapter());
    const strangerId = randomUUID();
    harness.reap(strangerId);
    expect(await awaitReapState(harness.relay, strangerId)).toEqual({
      sessionId: strangerId,
      ok: false,
      code: 'unknown-session',
    });
  });

  it('refuses to reap a session that is still running (not-reapable, worktree intact)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = await startHarness({
      async run(_prompt, opts) {
        await gate;
        opts.onEvent({ type: 'message', text: 'done' });
        return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
      },
    });
    const sessionId = randomUUID();
    harness.launch(sessionId);
    await harness.relay.waitForFrame((e) => e.type === 'session.started');

    harness.reap(sessionId);
    expect(await awaitReapState(harness.relay, sessionId)).toEqual({
      sessionId,
      ok: false,
      code: 'not-reapable',
    });
    expect(await exists(join(harness.worktreesRoot, sessionId))).toBe(true);

    release(); // let the run settle so teardown is clean
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');
  });

  it('refuses a dirty worktree with the coded story (nothing deleted)', async () => {
    const harness = await startHarness(instantAdapter());
    const sessionId = randomUUID();
    harness.launch(sessionId);
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');
    await appendFile(join(harness.worktreesRoot, sessionId, 'README.md'), 'uncommitted\n');

    harness.reap(sessionId);
    expect(await awaitReapState(harness.relay, sessionId)).toEqual({
      sessionId,
      ok: false,
      code: 'dirty',
    });
    expect(await exists(join(harness.worktreesRoot, sessionId))).toBe(true);
    expect(await exists(join(harness.storeDir, `${sessionId}.json`))).toBe(true);
  });
});
