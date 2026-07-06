import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeKey,
  generateKeyPair,
  makeEnvelope,
  sessionMetaPayloadSchema,
  type KeyPair,
  type SessionMetaPayload,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';
import {
  decryptWithContentKey,
  encryptWithContentKey,
  mkE2eIds,
  ofType,
  sendSealedLaunch,
  sendSubscribe,
  startE2eDaemon,
  unwrapContentKey,
  type E2eIds,
  type SealedFields,
} from './e2e-harness';
import { createSessionStore } from './sessions/session-store';
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

  it('emits an updated session.meta carrying the model once the turn learns it (T5)', async () => {
    const ids = mkE2eIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startDaemon(
      ids,
      daemonKp,
      createFakeAgentAdapter([{ type: 'message', text: 'on it' }], {
        sessionId: 'sdk-m',
        model: 'claude-sonnet-5',
      }),
    );

    await sendSealedLaunch(relay, ids, daemonKp, browserKp, { prompt: 'do it' });
    const keyFrame = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);

    // Enqueue order is deterministic (one send chain): the launch meta (no model, model not known yet)
    // precedes the turn-end model update. So the SECOND session.meta is the one that carries the model.
    const launchMeta = await openMeta(
      await relay.waitForFrame(ofType('session.meta', ids.sessionId)),
      contentKey,
    );
    expect(launchMeta.model).toBeUndefined();
    const modelMeta = await openMeta(
      await relay.waitForFrame(ofType('session.meta', ids.sessionId)),
      contentKey,
    );
    expect(modelMeta.model).toBe('claude-sonnet-5');
    // The frame carries the FULL merged snapshot, not just the model patch (documented latest-wins).
    expect(modelMeta.title).toBe('do it');
  });

  it('does NOT re-emit session.meta on a second turn reporting the same model (T5)', async () => {
    const ids = mkE2eIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startDaemon(
      ids,
      daemonKp,
      createFakeAgentAdapter([{ type: 'message', text: 'ok' }], {
        sessionId: 'sdk-m2',
        model: 'claude-sonnet-5',
      }),
    );

    await sendSealedLaunch(relay, ids, daemonKp, browserKp, { prompt: 'first' });
    const contentKey = await unwrapContentKey(
      await relay.waitForFrame(ofType('session.key', ids.sessionId)),
      daemonKp.publicKey,
      browserKp.privateKey,
    );
    // Turn 1: launch meta + the model-update meta (2 metas).
    await relay.waitForFrame(ofType('session.meta', ids.sessionId));
    await relay.waitForFrame(ofType('session.meta', ids.sessionId));
    await relay.waitForFrame(ofType('session.ended', ids.sessionId));

    // Turn 2 reports the SAME model → no new session.meta. Prove it by draining to the terminal
    // session.ended (a barrier that can't miss an out-of-order frame); any session.meta in between is a
    // regression and fails immediately, naming the offending frame — not as an opaque 5s drain timeout.
    // The follow-up is encrypted under the content key (the session is E2E).
    const sealed = await encryptWithContentKey({ text: 'second' }, contentKey);
    relay.send(
      makeEnvelope({
        type: 'user.message',
        userId: ids.userId,
        deviceId: ids.deviceId,
        sessionId: ids.sessionId,
        payload: sealed.payload,
        nonce: sealed.nonce,
      }),
    );
    for (;;) {
      const frame = await relay.waitForFrame(
        (e) =>
          e.session_id === ids.sessionId &&
          (e.type === 'session.meta' || e.type === 'session.ended'),
      );
      if (frame.type === 'session.ended') break;
      throw new Error(
        `expected no session.meta re-emit for an unchanged model, got: ${JSON.stringify(frame)}`,
      );
    }
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

describe('daemon session.meta key durability across restart (session-identity T3)', () => {
  it(
    're-delivers the SAME content key and re-emits the sealed metadata after a restart',
    { timeout: 30000 },
    async () => {
      const ids = mkE2eIds();
      const daemonKp = await generateKeyPair();
      const browserKp = await generateKeyPair();
      const dir = await mkdtemp(join(tmpdir(), 'telecode-t3-'));
      const kpFields = (kp: KeyPair) => ({
        publicKey: encodeKey(kp.publicKey),
        privateKey: encodeKey(kp.privateKey),
      });
      try {
        // Daemon A: launch an E2E session to completion so its transcript + content key + meta persist.
        const relayA = await startFakeRelay(ids.userId, ids.deviceId);
        const daemonA = createDaemon({
          relayUrl: relayA.url,
          userId: ids.userId,
          deviceId: ids.deviceId,
          keyPair: kpFields(daemonKp),
          agentAdapter: createFakeAgentAdapter([{ type: 'message', text: 'done' }], {
            sessionId: 'sdk-t3',
          }),
          sessionStore: createSessionStore({ dir }),
          logger: silent,
        });
        await daemonA.start();

        await sendSealedLaunch(relayA, ids, daemonKp, browserKp, { prompt: 'the durable title' });
        const keyA = await unwrapContentKey(
          await relayA.waitForFrame(ofType('session.key', ids.sessionId)),
          daemonKp.publicKey,
          browserKp.privateKey,
        );
        await relayA.waitForFrame(ofType('session.ended', ids.sessionId));
        // Wait for the coalesced async persist (transcript + content key) to land on disk.
        await vi.waitFor(
          async () => {
            const persisted = (await createSessionStore({ dir }).loadAll()).get(ids.sessionId);
            expect(persisted?.contentKey).toEqual(expect.any(String));
          },
          { timeout: 5000, interval: 50 },
        );
        await daemonA.stop();
        await relayA.close();

        // Daemon B: same identity + store, fresh process — the restored session must NOT rotate its key.
        const relayB = await startFakeRelay(ids.userId, ids.deviceId);
        relays.push(relayB);
        const daemonB = createDaemon({
          relayUrl: relayB.url,
          userId: ids.userId,
          deviceId: ids.deviceId,
          keyPair: kpFields(daemonKp),
          agentAdapter: createFakeAgentAdapter([], { sessionId: 'sdk-t3' }),
          sessionStore: createSessionStore({ dir }),
          logger: silent,
        });
        daemons.push(daemonB);
        await daemonB.start();

        // A browser reopens: it gets the SAME key (a pre-restart blob stays decryptable) AND the meta.
        const browser2 = await generateKeyPair();
        sendSubscribe(relayB, ids, encodeKey(browser2.publicKey));
        const keyB = await unwrapContentKey(
          await relayB.waitForFrame(ofType('session.key', ids.sessionId)),
          daemonKp.publicKey,
          browser2.privateKey,
        );
        expect(keyB).toBe(keyA); // the decisive property: the key did NOT rotate across the restart

        const meta = await openMeta(
          await relayB.waitForFrame(ofType('session.meta', ids.sessionId)),
          keyB,
        );
        expect(meta.title).toBe('the durable title');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
