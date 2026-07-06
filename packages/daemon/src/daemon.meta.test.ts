import {
  encodeKey,
  generateKeyPair,
  makeEnvelope,
  sessionMetaPayloadSchema,
  type SessionMetaPayload,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import {
  decryptWithContentKey,
  mkE2eIds,
  ofType,
  sendSealedLaunch,
  sendSubscribe,
  startE2eDaemon,
  unwrapContentKey,
  type E2eIds,
  type SealedFields,
} from './e2e-harness';
import { type WorktreeManager } from './sessions/worktree-manager';

/**
 * Sealed session metadata (ux Phase 6, T1 walking skeleton). On launch the daemon must emit a
 * `session.meta` frame — sealed under the per-session content key — carrying the session's identity:
 * a title (derived from the first prompt, or the user's own), the working directory it runs in, and
 * the permission mode. The relay stores the opaque blob; only key-holding browsers can read it.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

async function startDaemon(
  ids: E2eIds,
  daemonKp: Awaited<ReturnType<typeof generateKeyPair>>,
  agentAdapter: AgentAdapter,
  extras: { worktreeManager?: WorktreeManager; defaultRepoPath?: string } = {},
): Promise<FakeRelay> {
  const { daemon, relay } = await startE2eDaemon({
    ids,
    daemonKeyPair: daemonKp,
    agentAdapter,
    extras: { logger: silent, ...extras },
  });
  daemons.push(daemon);
  relays.push(relay);
  return relay;
}

async function openMeta(frame: SealedFields, contentKey: string): Promise<SessionMetaPayload> {
  return sessionMetaPayloadSchema.parse(await decryptWithContentKey(frame, contentKey));
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('daemon session.meta on launch (session-identity T1)', () => {
  it('emits a sealed session.meta with a title derived from the first prompt', async () => {
    const ids = mkE2eIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startDaemon(
      ids,
      daemonKp,
      createFakeAgentAdapter([{ type: 'message', text: 'on it' }], { sessionId: 'sdk-1' }),
    );

    const PROMPT = 'Refactor the auth module\nand also update the tests for it';
    await sendSealedLaunch(relay, ids, daemonKp, browserKp, {
      prompt: PROMPT,
      permissionMode: 'acceptEdits',
    });

    const keyFrame = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);

    const metaFrame = await relay.waitForFrame(ofType('session.meta', ids.sessionId));
    // Sealed: the relay (and this fake relay) must only ever see ciphertext — never the prompt text.
    expect(typeof metaFrame.payload).toBe('string');
    expect(metaFrame.nonce).not.toBe('');
    expect(JSON.stringify(metaFrame)).not.toContain('Refactor');

    const meta = await openMeta(metaFrame, contentKey);
    // Title = the prompt's first line; the second line must not leak into it.
    expect(meta.title).toBe('Refactor the auth module');
    expect(meta.titleSource).toBe('derived');
    expect(meta.permissionMode).toBe('acceptEdits');
    expect(meta.ts).toEqual(expect.any(Number));
  });

  it('carries the session worktree cwd once the workspace is prepared', async () => {
    const ids = mkE2eIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    // A minimal in-memory worktree manager: the meta contract needs the PATH the session runs in,
    // not real git plumbing (covered by daemon.worktree.test.ts).
    const worktreeManager: WorktreeManager = {
      ensureWorktree: (sessionId) =>
        Promise.resolve({ path: `/worktrees/${sessionId}`, branch: `telecode/${sessionId}` }),
    };
    const relay = await startDaemon(
      ids,
      daemonKp,
      createFakeAgentAdapter([], { sessionId: 'sdk-cwd' }),
      { worktreeManager, defaultRepoPath: '/repos/app' },
    );

    await sendSealedLaunch(relay, ids, daemonKp, browserKp, { prompt: 'run in a worktree' });

    const keyFrame = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);
    const meta = await openMeta(
      await relay.waitForFrame(ofType('session.meta', ids.sessionId)),
      contentKey,
    );

    expect(meta.cwd).toBe(`/worktrees/${ids.sessionId}`);
  });

  it('truncates a long first prompt into a bounded single-line title', async () => {
    const ids = mkE2eIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startDaemon(
      ids,
      daemonKp,
      createFakeAgentAdapter([], { sessionId: 'sdk-2' }),
    );

    const longPrompt = `please ${'very '.repeat(40)}carefully refactor everything`;
    await sendSealedLaunch(relay, ids, daemonKp, browserKp, { prompt: longPrompt });

    const keyFrame = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);
    const meta = await openMeta(
      await relay.waitForFrame(ofType('session.meta', ids.sessionId)),
      contentKey,
    );

    // toMatch first: it fails cleanly on `undefined`, unlike the length read behind the non-null.
    expect(meta.title).toMatch(/…$/);
    expect(meta.title).not.toContain('\n');
    expect(meta.title!.length).toBeLessThanOrEqual(80);
  });

  it('prefers a user-provided launch title and marks it user-sourced', async () => {
    const ids = mkE2eIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startDaemon(
      ids,
      daemonKp,
      createFakeAgentAdapter([], { sessionId: 'sdk-3' }),
    );

    await sendSealedLaunch(relay, ids, daemonKp, browserKp, {
      prompt: 'do the thing',
      title: 'My named run',
    });

    const keyFrame = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);
    const meta = await openMeta(
      await relay.waitForFrame(ofType('session.meta', ids.sessionId)),
      contentKey,
    );

    expect(meta.title).toBe('My named run');
    expect(meta.titleSource).toBe('user');
  });

  it('emits a plain-object session.meta in cleartext mode (no daemon keypair, pre-E2E path)', async () => {
    const ids = mkE2eIds();
    const relay = await startFakeRelay(ids.userId, ids.deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: ids.userId,
      deviceId: ids.deviceId,
      agentAdapter: createFakeAgentAdapter([], { sessionId: 'sdk-clear' }),
      logger: silent,
    });
    daemons.push(daemon);
    await daemon.start();

    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId: ids.userId,
        deviceId: ids.deviceId,
        sessionId: ids.sessionId,
        payload: { prompt: 'plain mode run', permissionMode: 'default' },
      }),
    );

    const metaFrame = await relay.waitForFrame(ofType('session.meta', ids.sessionId));
    // Cleartext mode: an empty nonce and a schema-valid plain object — what legacy relays/browsers see.
    expect(metaFrame.nonce).toBe('');
    const meta = sessionMetaPayloadSchema.parse(metaFrame.payload);
    expect(meta).toMatchObject({
      title: 'plain mode run',
      titleSource: 'derived',
      permissionMode: 'default',
    });
  });

  it('re-sends session.meta to a subscriber (reopen has identity even without the relay cache)', async () => {
    const ids = mkE2eIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startDaemon(
      ids,
      daemonKp,
      createFakeAgentAdapter([], { sessionId: 'sdk-4' }),
    );

    await sendSealedLaunch(relay, ids, daemonKp, browserKp, { prompt: 'first prompt wins' });
    // Drain the launch-time frames (waitForFrame CONSUMES on match), so the next session.meta we await
    // can only be a fresh re-send — not the launch-time one read back out of the buffer.
    await relay.waitForFrame(ofType('session.key', ids.sessionId));
    await relay.waitForFrame(ofType('session.meta', ids.sessionId));
    await relay.waitForFrame(ofType('session.ended', ids.sessionId));

    // A second browser subscribes: it must get a key delivery AND a fresh session.meta it can open.
    const browser2 = await generateKeyPair();
    sendSubscribe(relay, ids, encodeKey(browser2.publicKey));
    const keyFrame = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browser2.privateKey);
    const metaFrame = await relay.waitForFrame(ofType('session.meta', ids.sessionId));
    const meta = await openMeta(metaFrame, contentKey);
    expect(meta.title).toBe('first prompt wins');
  });
});
