import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { makeEnvelope, sessionChangesPayloadSchema } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createSessionStore } from './sessions/session-store';
import { createGitChangesReader } from './sessions/workspace-changes';
import { createGitWorktreeManager } from './sessions/worktree-manager';

const run = promisify(execFile);
const silent = pino({ level: 'silent' });

/**
 * The Changes-panel walking skeleton (branch-actions T1): a launched session's branch-diff summary
 * travels daemon → relay → browser as `session.changes`. Real daemon ↔ in-process fake relay ↔ a real
 * git worktree; cleartext daemon (no keypair) so the payload shape is assertable — the seal path is
 * shared with `session.meta`, which the E2E meta suite already proves.
 */
describe('daemon: session.changes round-trip (branch-actions T1)', () => {
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
    const dir = await tempDir('telecode-changes-repo-');
    await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', dir, 'config', 'user.name', 'telecode-test']);
    await appendFile(join(dir, 'README.md'), '# repo\n');
    await run('git', ['-C', dir, 'add', '.']);
    await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
    return dir;
  }

  interface Harness {
    relay: FakeRelay;
    sessionId: string;
    worktreePath: string;
    userId: string;
    deviceId: string;
    /** Restart the daemon: stop it, dial a fresh relay, restore from the same session store. */
    restart: () => Promise<FakeRelay>;
  }

  async function launchSession(options?: {
    adapter?: AgentAdapter;
    sessionStoreDir?: string;
  }): Promise<Harness> {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const repoPath = await makeRepo();
    const worktreesRoot = await tempDir('telecode-changes-worktrees-');
    const storeDir = options?.sessionStoreDir;

    async function start(): Promise<{ relay: FakeRelay; daemon: Daemon }> {
      const relay = await startFakeRelay(userId, deviceId);
      relays.push(relay);
      const daemon = createDaemon({
        relayUrl: relay.url,
        userId,
        deviceId,
        agentAdapter: options?.adapter ?? createFakeAgentAdapter([]),
        logger: silent,
        worktreeManager: createGitWorktreeManager({ worktreesRoot, logger: silent }),
        defaultRepoPath: repoPath,
        readWorkspaceChanges: createGitChangesReader(),
        ...(storeDir !== undefined
          ? { sessionStore: createSessionStore({ dir: storeDir, logger: silent }) }
          : {}),
      });
      daemons.push(daemon);
      await daemon.start();
      return { relay, daemon };
    }

    const first = await start();
    const sessionId = randomUUID();
    first.relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId,
        payload: { prompt: 'walking skeleton change' },
      }),
    );
    return {
      relay: first.relay,
      sessionId,
      worktreePath: join(worktreesRoot, sessionId),
      userId,
      deviceId,
      restart: async () => {
        await first.daemon.stop();
        return (await start()).relay;
      },
    };
  }

  it('emits an empty diff summary once the workspace is ready', async () => {
    const { relay } = await launchSession();

    const changes = sessionChangesPayloadSchema.parse(
      (await relay.waitForFrame((e) => e.type === 'session.changes')).payload,
    );
    expect(changes.baseBranch).toBe('main');
    expect(changes.files).toEqual([]);
    expect(changes.totalAdditions).toBe(0);
    expect(changes.totalDeletions).toBe(0);
    expect(changes.truncated).toBe(false);
  });

  it('recomputes the real diff vs the base on subscribe', async () => {
    const { relay, sessionId, worktreePath, userId, deviceId } = await launchSession();
    // Drain BOTH in-flight summaries — the launch seed and the turn-end re-emit — before touching
    // the worktree. Their fire-and-forget git reads race any mutation made while they're in
    // flight; once both frames have arrived, nothing is reading, so the next `session.changes`
    // can only be the subscribe's own recompute.
    await relay.waitForFrame((e) => e.type === 'session.ended');
    await relay.waitForFrame((e) => e.type === 'session.changes');
    await relay.waitForFrame((e) => e.type === 'session.changes');
    // The session's work: one committed line and one uncommitted line — BOTH must count, the
    // panel reports the branch's full drift from its base, not just what's committed.
    await appendFile(join(worktreePath, 'README.md'), 'committed line\n');
    await run('git', ['-C', worktreePath, 'commit', '-aqm', 'agent work']);
    await appendFile(join(worktreePath, 'README.md'), 'uncommitted line\n');

    relay.send(
      makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }),
    );
    const changes = sessionChangesPayloadSchema.parse(
      (await relay.waitForFrame((e) => e.type === 'session.changes')).payload,
    );
    expect(changes.baseBranch).toBe('main');
    expect(changes.files).toEqual([{ path: 'README.md', additions: 2, deletions: 0 }]);
    expect(changes.totalAdditions).toBe(2);
    expect(changes.totalDeletions).toBe(0);
    expect(changes.truncated).toBe(false);
  });

  it('re-emits the summary when a turn ends, so the panel tracks the agent work (T2)', async () => {
    // An adapter that does what agents do: writes a (still-untracked) file into its cwd.
    const adapter: AgentAdapter = {
      async run(_prompt, opts) {
        if (opts.cwd !== undefined) {
          await appendFile(join(opts.cwd, 'agent-was-here.txt'), 'hello\n');
        }
        opts.onEvent({ type: 'message', text: 'done' });
        return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
      },
    };
    const { relay } = await launchSession({ adapter });

    // The turn-end re-emit must carry the agent's untracked file with honest null counts
    // (unknowable without mutating the index). The launch-time seed RACES the adapter's write
    // (both are async), so this waits for the summary that CONTAINS the work — its existence is
    // the contract; seed-emptiness is a timing artifact deliberately not asserted here.
    await relay.waitForFrame((e) => e.type === 'session.ended');
    const after = sessionChangesPayloadSchema.parse(
      (
        await relay.waitForFrame((e) => {
          if (e.type !== 'session.changes') return false;
          const parsed = sessionChangesPayloadSchema.safeParse(e.payload);
          return parsed.success && parsed.data.files.length > 0;
        })
      ).payload,
    );
    expect(after.files).toEqual([{ path: 'agent-was-here.txt', additions: null, deletions: null }]);
    expect(after.totalAdditions).toBe(0);
  });

  it('keeps the base across a daemon restart (persisted), so a reopen still diffs honestly (T2)', async () => {
    const storeDir = await tempDir('telecode-changes-store-');
    const { relay, sessionId, worktreePath, userId, deviceId, restart } = await launchSession({
      sessionStoreDir: storeDir,
    });
    // Terminal (persist point) first, then the branch drifts while the daemon is down.
    await relay.waitForFrame((e) => e.type === 'session.ended');
    await appendFile(join(worktreePath, 'README.md'), 'work after end\n');
    await run('git', ['-C', worktreePath, 'commit', '-aqm', 'post-end work']);

    const reborn = await restart();
    reborn.send(
      makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }),
    );
    const changes = sessionChangesPayloadSchema.parse(
      (await reborn.waitForFrame((e) => e.type === 'session.changes')).payload,
    );
    expect(changes.baseBranch).toBe('main');
    expect(changes.files).toEqual([{ path: 'README.md', additions: 1, deletions: 0 }]);
  });
});
