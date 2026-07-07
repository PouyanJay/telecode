import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { makeEnvelope, repoBranchesStatePayloadSchema } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createGitBranchLister } from './sessions/branch-list';

const run = promisify(execFile);
const silent = pino({ level: 'silent' });

/**
 * The sealed local-branch round-trip (branch-launch T5): the web asks `repo.branches`, the daemon
 * answers `repo.branches.state` with the DEFAULT repo's branches — sealed to the requester on an E2E
 * daemon (shared seal path with adopt.state); cleartext here (no keypair) so the shape is assertable.
 */
describe('daemon: repo.branches round-trip (branch-launch T5)', () => {
  const daemons: Daemon[] = [];
  const relays: FakeRelay[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((d) => d.stop()));
    await Promise.all(relays.splice(0).map((r) => r.close()));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'telecode-branches-repo-'));
    tempDirs.push(dir);
    await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', dir, 'config', 'user.name', 'telecode-test']);
    await run('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'root']);
    await run('git', ['-C', dir, 'branch', 'develop']);
    return dir;
  }

  async function start(extras: Partial<Parameters<typeof createDaemon>[0]>): Promise<{
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
      agentAdapter: createFakeAgentAdapter([]),
      logger: silent,
      ...extras,
    });
    daemons.push(daemon);
    await daemon.start();
    return { relay, userId, deviceId };
  }

  it("answers with the default repo's branches and its checked-out default", async () => {
    const repo = await makeRepo();
    const { relay, userId, deviceId } = await start({
      defaultRepoPath: repo,
      listRepoBranches: createGitBranchLister(),
    });

    relay.send(makeEnvelope({ type: 'repo.branches', userId, deviceId, payload: {} }));
    const state = repoBranchesStatePayloadSchema.parse(
      (await relay.waitForFrame((e) => e.type === 'repo.branches.state')).payload,
    );
    expect(state.available).toBe(true);
    expect(state.branches.sort()).toEqual(['develop', 'main']);
    expect(state.defaultBranch).toBe('main');
  });

  it('answers unavailable when no default repo is configured', async () => {
    const { relay, userId, deviceId } = await start({ listRepoBranches: createGitBranchLister() });
    relay.send(makeEnvelope({ type: 'repo.branches', userId, deviceId, payload: {} }));
    const state = repoBranchesStatePayloadSchema.parse(
      (await relay.waitForFrame((e) => e.type === 'repo.branches.state')).payload,
    );
    expect(state).toEqual({ available: false, branches: [] });
  });

  it('fails soft to unavailable when the default repo cannot be listed', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'telecode-not-repo-'));
    tempDirs.push(notARepo);
    const { relay, userId, deviceId } = await start({
      defaultRepoPath: notARepo,
      listRepoBranches: createGitBranchLister(),
    });
    relay.send(makeEnvelope({ type: 'repo.branches', userId, deviceId, payload: {} }));
    const state = repoBranchesStatePayloadSchema.parse(
      (await relay.waitForFrame((e) => e.type === 'repo.branches.state')).payload,
    );
    expect(state).toEqual({ available: false, branches: [] });
  });
});
