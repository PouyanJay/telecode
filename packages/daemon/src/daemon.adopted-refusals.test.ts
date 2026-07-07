import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  makeEnvelope,
  sessionBranchStatePayloadSchema,
  sessionPushStatePayloadSchema,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createDaemon, type Daemon } from './daemon';
import { createFakeAgentAdapter } from './agent-adapter';
import { hookRpc } from './hook-rpc';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import { createGitBranchPusher } from './sessions/branch-push';
import { createGitBranchSwitcher } from './sessions/branch-switcher';

const silent = pino({ level: 'silent' });

/**
 * Adopted sessions are display-only for every Phase C action (variant sweep, T7): telecode never
 * moves, publishes, or deletes the user's own checkout. The reap refusal has its own test (T3
 * review round); this covers the other two destructive-adjacent asks against a REAL adoption —
 * a dropped `origin === 'external'` guard must fail HERE, not in a unit mirror.
 */
describe('daemon: adopted sessions refuse switch and push (branch-actions T7)', () => {
  const daemons: Daemon[] = [];
  const relays: FakeRelay[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((d) => d.stop()));
    await Promise.all(relays.splice(0).map((r) => r.close()));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('answers not-launched to both asks on a session adopted over the hook socket', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopted-refusals-'));
    tempDirs.push(dir);
    const socketPath = join(dir, 'hook.sock');
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: createFakeAgentAdapter([]),
      logger: silent,
      adopt: { socketPath, ackTimeoutMs: 2000 },
      // Both seams present, so the refusal below is the ORIGIN guard — not a missing-seam accident.
      switchBranch: createGitBranchSwitcher(),
      pushBranch: createGitBranchPusher(),
    });
    daemons.push(daemon);
    await daemon.start();

    const sessionId = randomUUID();
    const decision = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: 'claude-external-refusals',
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
    await decision;

    relay.send(
      makeEnvelope({
        type: 'session.branch.switch',
        userId,
        deviceId,
        sessionId,
        payload: { branch: 'main' },
      }),
    );
    const switchState = sessionBranchStatePayloadSchema.parse(
      (
        await relay.waitForFrame(
          (e) => e.type === 'session.branch.state' && e.session_id === sessionId,
        )
      ).payload,
    );
    expect(switchState).toEqual({ ok: false, code: 'not-launched' });

    relay.send(makeEnvelope({ type: 'session.push', userId, deviceId, sessionId, payload: {} }));
    const pushState = sessionPushStatePayloadSchema.parse(
      (
        await relay.waitForFrame(
          (e) => e.type === 'session.push.state' && e.session_id === sessionId,
        )
      ).payload,
    );
    expect(pushState).toEqual({ ok: false, code: 'not-launched' });

    // Fork-onto-branch against the (now ended) adopted parent: the daemon holds no repo it may cut
    // from — the child must fail CLEANLY with the coded story, never touch the user's checkout.
    await hookRpc(socketPath, {
      hook_event_name: 'SessionEnd',
      session_id: 'claude-external-refusals',
      cwd: dir,
    });
    await relay.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sessionId);

    relay.send(
      makeEnvelope({
        type: 'session.resume_new',
        userId,
        deviceId,
        sessionId,
        payload: { prompt: 'continue on a branch', branchName: 'feat/from-adopted' },
      }),
    );
    const announce2 = await relay.waitForFrame((e) => e.type === 'session.chained');
    const childId = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.chained',
        userId,
        deviceId,
        sessionId: childId,
        payload: announce2.payload,
      }),
    );
    const childEnded = await relay.waitForFrame(
      (e) => e.type === 'session.ended' && e.session_id === childId,
    );
    expect(childEnded.payload).toMatchObject({
      status: 'error',
      error: 'cannot fork onto a branch: the original repo is not available here',
    });
  });
});
