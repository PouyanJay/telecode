import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as RelaySocket } from 'ws';

import { type AgentAdapter, type AgentRunOptions } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { createGitWorktreeManager, type WorktreeManager } from './sessions/worktree-manager';

const run = promisify(execFile);
const silent = pino({ level: 'silent' });

// Real daemon ↔ an in-process fake relay (WS) ↔ a real git worktree. The only faked layer is the agent
// model (a recording adapter), which is the correct boundary — a live model is the opt-in `live-agent`
// test. This proves the daemon cuts a worktree per session and runs the agent in it.

const tempDirs: string[] = [];
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const dir = await tempDir('telecode-repo-');
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.dev']);
  await run('git', ['-C', dir, 'config', 'user.name', 'Telecode Test']);
  await writeFile(join(dir, 'README.md'), '# repo\n');
  await run('git', ['-C', dir, 'add', '.']);
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
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

interface RecordedRun {
  readonly prompt: string;
  readonly cwd?: string;
  readonly resume?: string;
}

/** An adapter that records each run's cwd/resume and writes a file in its cwd (proving where it ran). */
function recordingAdapter(runs: RecordedRun[]): AgentAdapter {
  return {
    async run(prompt: string, opts: AgentRunOptions) {
      runs.push({
        prompt,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
      });
      if (opts.cwd !== undefined) {
        await writeFile(join(opts.cwd, 'agent-was-here.txt'), prompt);
      }
      opts.onEvent({ type: 'message', text: 'done' });
      return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
    },
  };
}

interface FakeRelay {
  readonly url: string;
  send(envelope: Envelope): void;
  waitForFrame(predicate: (e: Envelope) => boolean): Promise<Envelope>;
  close(): Promise<void>;
}

/** A minimal stand-in for the relay: acks `hello`, then ferries frames to/from the daemon under test. */
async function startFakeRelay(userId: string, deviceId: string): Promise<FakeRelay> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake relay has no port');
  const url = `ws://127.0.0.1:${address.port}`;

  let socket: RelaySocket | null = null;
  const buffered: Envelope[] = [];
  const waiters: { predicate: (e: Envelope) => boolean; resolve: (e: Envelope) => void }[] = [];

  function deliver(envelope: Envelope): void {
    const index = waiters.findIndex((w) => w.predicate(envelope));
    if (index >= 0) waiters.splice(index, 1)[0]?.resolve(envelope);
    else buffered.push(envelope);
  }

  server.on('connection', (conn: RelaySocket) => {
    socket = conn;
    conn.on('message', (raw: Buffer) => {
      let envelope: Envelope;
      try {
        envelope = parseEnvelope(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (envelope.type === 'hello') {
        conn.send(
          JSON.stringify(makeEnvelope({ type: 'hello.ack', userId, deviceId, payload: {} })),
        );
        return;
      }
      deliver(envelope);
    });
  });

  return {
    url,
    send(envelope: Envelope): void {
      if (!socket) throw new Error('fake relay: daemon not connected yet');
      socket.send(JSON.stringify(envelope));
    },
    waitForFrame(predicate): Promise<Envelope> {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0] as Envelope);
      return new Promise<Envelope>((resolve, reject) => {
        // Event-driven; the 5s deadline is only an abort guard on real WS I/O (matches AD-P2-6).
        const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), 5000);
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function startDaemon(
  userId: string,
  deviceId: string,
  adapter: AgentAdapter,
  worktreeManager?: WorktreeManager,
): Promise<FakeRelay> {
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    agentAdapter: adapter,
    logger: silent,
    ...(worktreeManager ? { worktreeManager } : {}),
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('daemon: a git worktree per session (Task 6)', () => {
  it('runs each session in its own worktree, isolates them, reuses on follow-up, and keeps them on end', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const repoPath = await makeRepo();
    const worktreesRoot = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ repoPath, worktreesRoot, logger: silent });
    const runs: RecordedRun[] = [];
    const relay = await startDaemon(userId, deviceId, recordingAdapter(runs), manager);

    // Session A.
    const sidA = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sidA,
        payload: { prompt: 'work on A' },
      }),
    );
    await relay.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sidA);

    const wtA = join(worktreesRoot, sidA);
    expect(runs[0]?.cwd).toBe(wtA);
    // The agent ran in the worktree — its file is there and NOT in the repo root / daemon cwd.
    expect(await readFile(join(wtA, 'agent-was-here.txt'), 'utf8')).toBe('work on A');
    expect(await exists(join(repoPath, 'agent-was-here.txt'))).toBe(false);
    const { stdout: branchA } = await run('git', ['-C', wtA, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branchA.trim()).toBe(`telecode/${sidA.slice(0, 8)}`);

    // Session B — its own isolated worktree.
    const sidB = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sidB,
        payload: { prompt: 'work on B' },
      }),
    );
    await relay.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sidB);

    const wtB = join(worktreesRoot, sidB);
    expect(runs[1]?.cwd).toBe(wtB);
    expect(await readFile(join(wtB, 'agent-was-here.txt'), 'utf8')).toBe('work on B');
    // A's worktree is untouched by B.
    expect(await readFile(join(wtA, 'agent-was-here.txt'), 'utf8')).toBe('work on A');

    // Follow-up on A reuses the same worktree cwd (resume turn).
    relay.send(
      makeEnvelope({
        type: 'user.message',
        userId,
        deviceId,
        sessionId: sidA,
        payload: { text: 'keep going on A' },
      }),
    );
    await relay.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sidA);
    const followUp = runs.find((r) => r.resume !== undefined);
    expect(followUp?.cwd).toBe(wtA);

    // Kept on end: both worktrees + branches still present after the sessions ended.
    expect(await exists(wtA)).toBe(true);
    expect(await exists(wtB)).toBe(true);
    const { stdout: list } = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    expect(list).toContain(wtA);
    expect(list).toContain(wtB);
  });

  it('runs in the daemon cwd (no worktree) when no worktree manager is configured', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const runs: RecordedRun[] = [];
    const relay = await startDaemon(userId, deviceId, recordingAdapter(runs));

    const sid = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sid,
        payload: { prompt: 'no repo configured' },
      }),
    );
    await relay.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sid);

    expect(runs[0]?.cwd).toBeUndefined();
  });

  it('ends the session with an error (agent never runs) when the worktree cannot be prepared', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const notARepo = await tempDir('telecode-not-a-repo-');
    const worktreesRoot = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ repoPath: notARepo, worktreesRoot, logger: silent });
    const runs: RecordedRun[] = [];
    const relay = await startDaemon(userId, deviceId, recordingAdapter(runs), manager);

    const sid = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId: sid,
        payload: { prompt: 'this cannot get a worktree' },
      }),
    );
    const ended = await relay.waitForFrame(
      (e) => e.type === 'session.ended' && e.session_id === sid,
    );

    expect((ended.payload as { status: string }).status).toBe('error');
    expect(runs).toHaveLength(0);
  });
});
