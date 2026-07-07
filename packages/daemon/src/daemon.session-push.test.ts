import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { makeEnvelope, sessionPushStatePayloadSchema } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createGitBranchPusher } from './sessions/branch-push';
import { createGitWorktreeManager } from './sessions/worktree-manager';

const run = promisify(execFile);
const silent = pino({ level: 'silent' });

/**
 * The push round-trip (branch-actions T6): the browser asks `session.push`, the daemon pushes the
 * session branch to origin (a REAL bare repo — the same credential-free transport a filesystem
 * remote gives) and answers `session.push.state`. Refusals are the coded matrix. Cleartext daemon
 * so payloads are assertable.
 */
describe('daemon: session.push round-trip (branch-actions T6)', () => {
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

  function instantAdapter(): AgentAdapter {
    return {
      async run(_prompt, opts) {
        opts.onEvent({ type: 'message', text: 'done' });
        return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
      },
    };
  }

  async function startHarness(options?: { withOrigin?: boolean }): Promise<{
    relay: FakeRelay;
    userId: string;
    deviceId: string;
    origin: string | undefined;
    worktreesRoot: string;
    launch: (sessionId: string) => void;
    push: (sessionId: string) => void;
  }> {
    const withOrigin = options?.withOrigin ?? true;
    // The session repo: a clone of a bare origin (push target), or a lone repo (no-remote case).
    let origin: string | undefined;
    let repoPath: string;
    if (withOrigin) {
      origin = await tempDir('telecode-push-rt-origin-');
      await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      const parent = await tempDir('telecode-push-rt-clone-');
      repoPath = join(parent, 'clone');
      await run('git', ['clone', '-q', '--', origin, repoPath]);
    } else {
      repoPath = await tempDir('telecode-push-rt-lone-');
      await run('git', ['-C', repoPath, 'init', '-q', '-b', 'main']);
    }
    await run('git', ['-C', repoPath, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', repoPath, 'config', 'user.name', 'telecode-test']);
    await appendFile(join(repoPath, 'README.md'), '# repo\n');
    await run('git', ['-C', repoPath, 'add', '.']);
    await run('git', ['-C', repoPath, 'commit', '-qm', 'init']);
    if (withOrigin) await run('git', ['-C', repoPath, 'push', '-q', 'origin', 'main']);

    const worktreesRoot = await tempDir('telecode-push-rt-worktrees-');
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: instantAdapter(),
      logger: silent,
      worktreeManager: createGitWorktreeManager({ worktreesRoot, logger: silent }),
      defaultRepoPath: repoPath,
      pushBranch: createGitBranchPusher(),
    });
    daemons.push(daemon);
    await daemon.start();
    return {
      relay,
      userId,
      deviceId,
      origin,
      worktreesRoot,
      launch: (sessionId) =>
        relay.send(
          makeEnvelope({
            type: 'session.launch',
            userId,
            deviceId,
            sessionId,
            payload: { prompt: 'push me later' },
          }),
        ),
      push: (sessionId) =>
        relay.send(
          makeEnvelope({ type: 'session.push', userId, deviceId, sessionId, payload: {} }),
        ),
    };
  }

  async function awaitPushState(relay: FakeRelay, sessionId: string) {
    return sessionPushStatePayloadSchema.parse(
      (
        await relay.waitForFrame(
          (e) => e.type === 'session.push.state' && e.session_id === sessionId,
        )
      ).payload,
    );
  }

  it('pushes the session branch to origin and reports branch + base for the PR page', async () => {
    const harness = await startHarness();
    const sessionId = randomUUID();
    harness.launch(sessionId);
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');
    // The session's work, committed on its branch.
    const cwd = join(harness.worktreesRoot, sessionId);
    await appendFile(join(cwd, 'README.md'), 'session work\n');
    await run('git', ['-C', cwd, 'commit', '-aqm', 'session work']);

    harness.push(sessionId);
    const state = await awaitPushState(harness.relay, sessionId);
    // A local filesystem origin is not github.com — honest reply carries no githubRepo.
    const branch = `telecode/push-me-later-${sessionId.slice(0, 8)}`;
    expect(state).toEqual({ ok: true, branch, base: 'main' });
    const listed = await run('git', ['-C', harness.origin!, 'branch', '--list', branch]);
    expect(listed.stdout).toContain(branch);
  });

  it('codes a repo without an origin as no-remote', async () => {
    const harness = await startHarness({ withOrigin: false });
    const sessionId = randomUUID();
    harness.launch(sessionId);
    await harness.relay.waitForFrame((e) => e.type === 'session.ended');

    harness.push(sessionId);
    expect(await awaitPushState(harness.relay, sessionId)).toEqual({
      ok: false,
      code: 'no-remote',
    });
  });

  it('answers not-launched for a session it never held', async () => {
    const harness = await startHarness();
    const stranger = randomUUID();
    harness.push(stranger);
    expect(await awaitPushState(harness.relay, stranger)).toEqual({
      ok: false,
      code: 'not-launched',
    });
  });

  it('refuses to push mid-turn — never publish a state the agent is writing', async () => {
    // Same harness shape, but the adapter holds its turn open until the test releases it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const origin = await tempDir('telecode-push-rt-mid-origin-');
    await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const parent = await tempDir('telecode-push-rt-mid-clone-');
    const repoPath = join(parent, 'clone');
    await run('git', ['clone', '-q', '--', origin, repoPath]);
    await run('git', ['-C', repoPath, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', repoPath, 'config', 'user.name', 'telecode-test']);
    await appendFile(join(repoPath, 'README.md'), '# repo\n');
    await run('git', ['-C', repoPath, 'add', '.']);
    await run('git', ['-C', repoPath, 'commit', '-qm', 'init']);
    await run('git', ['-C', repoPath, 'push', '-q', 'origin', 'main']);
    const worktreesRoot = await tempDir('telecode-push-rt-mid-worktrees-');
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: {
        async run(_prompt, opts) {
          await gate;
          opts.onEvent({ type: 'message', text: 'done' });
          return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-held' };
        },
      },
      logger: silent,
      worktreeManager: createGitWorktreeManager({ worktreesRoot, logger: silent }),
      defaultRepoPath: repoPath,
      pushBranch: createGitBranchPusher(),
    });
    daemons.push(daemon);
    await daemon.start();

    const sessionId = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId,
        payload: { prompt: 'push me mid-turn' },
      }),
    );
    await relay.waitForFrame((e) => e.type === 'session.started');

    relay.send(makeEnvelope({ type: 'session.push', userId, deviceId, sessionId, payload: {} }));
    expect(await awaitPushState(relay, sessionId)).toEqual({ ok: false, code: 'mid-turn' });

    release(); // settle the run so teardown is clean
    await relay.waitForFrame((e) => e.type === 'session.ended');
  });
});
