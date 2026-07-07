import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  makeEnvelope,
  repoBranchesStatePayloadSchema,
  sessionBranchStatePayloadSchema,
  sessionChangesPayloadSchema,
  sessionMetaPayloadSchema,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createGitBranchLister } from './sessions/branch-list';
import { createGitBranchSwitcher } from './sessions/branch-switcher';
import { createGitChangesReader } from './sessions/workspace-changes';
import { createGitWorktreeManager } from './sessions/worktree-manager';

const run = promisify(execFile);
const silent = pino({ level: 'silent' });

/**
 * The between-turns branch switch round-trip (branch-actions T4): the browser asks
 * `session.branch.switch`, the daemon moves the worktree and answers `session.branch.state`,
 * re-announcing the new branch via `session.meta` and a fresh `session.changes`. Refusals are the
 * coded matrix (mid-turn, not-found, …). Real daemon ↔ in-process fake relay ↔ real git; cleartext
 * daemon so payloads are assertable.
 */
describe('daemon: session.branch.switch round-trip (branch-actions T4)', () => {
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

  /** A repo on `main` with a spare `feat/other` (not checked out anywhere — switchable). */
  async function makeRepo(): Promise<string> {
    const dir = await tempDir('telecode-switch-rt-repo-');
    await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', dir, 'config', 'user.name', 'telecode-test']);
    await appendFile(join(dir, 'README.md'), '# repo\n');
    await run('git', ['-C', dir, 'add', '.']);
    await run('git', ['-C', dir, 'commit', '-qm', 'init']);
    await run('git', ['-C', dir, 'branch', 'feat/other']);
    // Park the parent repo on a detached HEAD so `main` is switchable too if a test wants it.
    return dir;
  }

  function instantAdapter(): AgentAdapter {
    return {
      async run(_prompt, opts) {
        opts.onEvent({ type: 'message', text: 'done' });
        return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
      },
    };
  }

  async function startHarness(adapter: AgentAdapter = instantAdapter()): Promise<{
    relay: FakeRelay;
    userId: string;
    deviceId: string;
    worktreesRoot: string;
    launch: (sessionId: string, prompt?: string) => void;
    switchTo: (sessionId: string, branch: string) => void;
  }> {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const repoPath = await makeRepo();
    const worktreesRoot = await tempDir('telecode-switch-rt-worktrees-');
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
      readWorkspaceChanges: createGitChangesReader(),
      listRepoBranches: createGitBranchLister(),
      switchBranch: createGitBranchSwitcher(),
    });
    daemons.push(daemon);
    await daemon.start();
    return {
      relay,
      userId,
      deviceId,
      worktreesRoot,
      launch: (sessionId, prompt = 'switch me later') =>
        relay.send(
          makeEnvelope({
            type: 'session.launch',
            userId,
            deviceId,
            sessionId,
            payload: { prompt },
          }),
        ),
      switchTo: (sessionId, branch) =>
        relay.send(
          makeEnvelope({
            type: 'session.branch.switch',
            userId,
            deviceId,
            sessionId,
            payload: { branch },
          }),
        ),
    };
  }

  async function awaitSwitchState(relay: FakeRelay, sessionId: string) {
    return sessionBranchStatePayloadSchema.parse(
      (
        await relay.waitForFrame(
          (e) => e.type === 'session.branch.state' && e.session_id === sessionId,
        )
      ).payload,
    );
  }

  it('switches between turns and re-announces branch + changes', async () => {
    const harness = await startHarness();
    const sessionId = randomUUID();
    harness.launch(sessionId);
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');

    harness.switchTo(sessionId, 'feat/other');
    expect(await awaitSwitchState(harness.relay, sessionId)).toEqual({
      ok: true,
      branch: 'feat/other',
    });
    // The worktree really moved.
    const head = await run('git', [
      '-C',
      join(harness.worktreesRoot, sessionId),
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    expect(head.stdout.trim()).toBe('feat/other');
    // Watchers hear about it: fresh meta with the new branch, and a recomputed summary.
    const meta = sessionMetaPayloadSchema.parse(
      (
        await harness.relay.waitForFrame((e) => {
          if (e.type !== 'session.meta') return false;
          const parsed = sessionMetaPayloadSchema.safeParse(e.payload);
          return parsed.success && parsed.data.branch === 'feat/other';
        })
      ).payload,
    );
    expect(meta.branch).toBe('feat/other');
    // The diff anchor stays the LAUNCH base (AD-6).
    const changes = sessionChangesPayloadSchema.parse(
      (
        await harness.relay.waitForFrame(
          (e) => e.type === 'session.changes' && e.session_id === sessionId,
        )
      ).payload,
    );
    expect(changes.baseBranch).toBe('main');
  });

  it('refuses mid-turn (worktree untouched), then allows once the turn settles', async () => {
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

    harness.switchTo(sessionId, 'feat/other');
    expect(await awaitSwitchState(harness.relay, sessionId)).toEqual({
      ok: false,
      code: 'mid-turn',
    });

    release();
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');
    harness.switchTo(sessionId, 'feat/other');
    expect(await awaitSwitchState(harness.relay, sessionId)).toEqual({
      ok: true,
      branch: 'feat/other',
    });
  });

  it('codes refusals: unknown session, missing branch, held branch, dirty tree', async () => {
    const harness = await startHarness();
    const sessionId = randomUUID();
    harness.launch(sessionId);
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');

    const stranger = randomUUID();
    harness.switchTo(stranger, 'feat/other');
    expect(await awaitSwitchState(harness.relay, stranger)).toEqual({
      ok: false,
      code: 'not-launched',
    });

    harness.switchTo(sessionId, 'no-such-branch');
    expect(await awaitSwitchState(harness.relay, sessionId)).toEqual({
      ok: false,
      code: 'not-found',
    });

    // `main` is checked out in the parent repo itself — the user's own working copy.
    harness.switchTo(sessionId, 'main');
    expect(await awaitSwitchState(harness.relay, sessionId)).toEqual({
      ok: false,
      code: 'checked-out-elsewhere',
    });

    // Uncommitted work in the worktree refuses through the whole round-trip, not just the seam.
    await appendFile(join(harness.worktreesRoot, sessionId, 'README.md'), 'uncommitted\n');
    harness.switchTo(sessionId, 'feat/other');
    expect(await awaitSwitchState(harness.relay, sessionId)).toEqual({
      ok: false,
      code: 'dirty',
    });
  });

  it('codes a session past following (error status) as ended', async () => {
    // An adapter that THROWS mid-run: the turn fails, the session settles as `error` — the state
    // whose refusal must be `ended` (nothing would continue it), never a misleading `mid-turn`.
    const harness = await startHarness({
      async run() {
        throw new Error('the agent run failed');
      },
    });
    const sessionId = randomUUID();
    harness.launch(sessionId);
    await harness.relay.waitForFrame(
      (e) => e.type === 'session.ended' && e.status === 'error' && e.session_id === sessionId,
    );

    harness.switchTo(sessionId, 'feat/other');
    expect(await awaitSwitchState(harness.relay, sessionId)).toEqual({ ok: false, code: 'ended' });
  });

  it('lists the SESSION repo’s branches for the picker and echoes the session id (AD-7)', async () => {
    const harness = await startHarness();
    const sessionId = randomUUID();
    harness.launch(sessionId);
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');

    harness.relay.send(
      makeEnvelope({
        type: 'repo.branches',
        userId: harness.userId,
        deviceId: harness.deviceId,
        payload: { sessionId },
      }),
    );
    const state = repoBranchesStatePayloadSchema.parse(
      (
        await harness.relay.waitForFrame((e) => {
          if (e.type !== 'repo.branches.state') return false;
          const parsed = repoBranchesStatePayloadSchema.safeParse(e.payload);
          return parsed.success && parsed.data.sessionId === sessionId;
        })
      ).payload,
    );
    expect(state.available).toBe(true);
    expect(state.branches).toContain('feat/other');
    expect(state.branches).toContain('main');

    // An unknown session answers unavailable — never the default repo's list by accident.
    const stranger = randomUUID();
    harness.relay.send(
      makeEnvelope({
        type: 'repo.branches',
        userId: harness.userId,
        deviceId: harness.deviceId,
        payload: { sessionId: stranger },
      }),
    );
    const unknown = repoBranchesStatePayloadSchema.parse(
      (
        await harness.relay.waitForFrame((e) => {
          if (e.type !== 'repo.branches.state') return false;
          const parsed = repoBranchesStatePayloadSchema.safeParse(e.payload);
          return parsed.success && parsed.data.sessionId === stranger;
        })
      ).payload,
    );
    expect(unknown).toEqual({ available: false, branches: [], sessionId: stranger });
  });
});
