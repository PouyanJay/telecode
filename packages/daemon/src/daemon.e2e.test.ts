import { randomUUID } from 'node:crypto';

import {
  decryptWithContentKey,
  encodeKey,
  encryptWithContentKey,
  generateKeyPair,
  makeEnvelope,
  sealEnvelopePayload,
  unwrapContentKey,
  type Envelope,
  type KeyPair,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentEvent } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Phase 3 Task 6 — daemon-side E2E. A keypair-bearing daemon must: decrypt a `session.launch` sealed
 * (box) to its public key, mint a per-session content key, deliver it (`session.key`, box-wrapped to the
 * browser's ephemeral key), encrypt every outbound stream frame under that content key (secretbox), and
 * decrypt encrypted inbound frames (permission decisions / follow-ups). The relay (here the fake relay)
 * only ever forwards ciphertext. Acts as the browser: it holds an ephemeral keypair + the daemon pubkey.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

async function startE2eDaemon(
  userId: string,
  deviceId: string,
  daemonKp: KeyPair,
  events: AgentEvent[],
): Promise<FakeRelay> {
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    keyPair: {
      publicKey: encodeKey(daemonKp.publicKey),
      privateKey: encodeKey(daemonKp.privateKey),
    },
    agentAdapter: createFakeAgentAdapter(events, { sessionId: 'sdk-1' }),
    logger: silent,
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

/** Browser-side: seal a launch to the daemon and send it with the browser's ephemeral pubkey announced. */
async function sendSealedLaunch(
  relay: FakeRelay,
  ids: { userId: string; deviceId: string; sessionId: string },
  daemonKp: KeyPair,
  browserKp: KeyPair,
  prompt: string,
): Promise<void> {
  const sealed = await sealEnvelopePayload({ prompt }, daemonKp.publicKey, browserKp.privateKey);
  relay.send(
    makeEnvelope({
      type: 'session.launch',
      userId: ids.userId,
      deviceId: ids.deviceId,
      sessionId: ids.sessionId,
      senderPublicKey: encodeKey(browserKp.publicKey),
      payload: sealed.payload,
      nonce: sealed.nonce,
    }),
  );
}

const ofType = (type: string, sessionId: string) => (e: Envelope) =>
  e.type === type && e.session_id === sessionId;

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('daemon E2E encryption (Task 6)', () => {
  it('decrypts the launch, delivers the session key, and encrypts the stream', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startE2eDaemon(userId, deviceId, daemonKp, [
      { type: 'message', text: 'planning the change' },
    ]);

    const PROMPT = 'delete all production data';
    await sendSealedLaunch(relay, { userId, deviceId, sessionId }, daemonKp, browserKp, PROMPT);

    // 1. The daemon delivers the content key, box-wrapped to the browser's ephemeral pubkey: the key
    //    itself travels as opaque ciphertext (a base64 string), never plaintext.
    const keyFrame = await relay.waitForFrame(ofType('session.key', sessionId));
    expect(JSON.stringify(keyFrame)).not.toContain(PROMPT);
    expect(typeof keyFrame.payload).toBe('string');
    expect(keyFrame.nonce).not.toBe('');
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);

    // 2. Even session.started (carrying only the correlation ref) is sealed under the content key.
    const startedFrame = await relay.waitForFrame(ofType('session.started', sessionId));
    expect(typeof startedFrame.payload).toBe('string');

    // 3. The streamed frames are ciphertext under the content key; the browser decrypts them.
    const messageFrame = await relay.waitForFrame(ofType('agent.message', sessionId));
    expect(typeof messageFrame.payload).toBe('string');
    expect(JSON.stringify(messageFrame)).not.toContain('planning the change');
    expect(await decryptWithContentKey(messageFrame, contentKey)).toEqual({
      text: 'planning the change',
    });

    // 3. session.ended carries the cleartext status (for the relay) AND the encrypted payload.
    const endedFrame = await relay.waitForFrame(ofType('session.ended', sessionId));
    expect(endedFrame.status).toBe('done');
    expect(await decryptWithContentKey(endedFrame, contentKey)).toMatchObject({ status: 'done' });
  });

  it('decrypts an encrypted permission decision and runs the gated tool', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startE2eDaemon(userId, deviceId, daemonKp, [
      { type: 'tool_use', toolName: 'Write', input: { path: 'README.md' } },
    ]);

    await sendSealedLaunch(
      relay,
      { userId, deviceId, sessionId },
      daemonKp,
      browserKp,
      'write a file',
    );
    const keyFrame = await relay.waitForFrame(ofType('session.key', sessionId));
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);

    // The gate request is encrypted; the browser decrypts it to read the correlation id.
    const requestFrame = await relay.waitForFrame(ofType('agent.permission_request', sessionId));
    expect(typeof requestFrame.payload).toBe('string');
    const request = (await decryptWithContentKey(requestFrame, contentKey)) as {
      requestId: string;
    };

    // The browser replies with an ENCRYPTED decision; the daemon must decrypt it to act.
    const sealedDecision = await encryptWithContentKey(
      { requestId: request.requestId, behavior: 'allow' },
      contentKey,
    );
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId,
        deviceId,
        sessionId,
        payload: sealedDecision.payload,
        nonce: sealedDecision.nonce,
      }),
    );

    // The decision was decrypted → the gated tool ran (its use streams, encrypted) and the session ended.
    const toolFrame = await relay.waitForFrame(ofType('agent.tool_use', sessionId));
    expect(await decryptWithContentKey(toolFrame, contentKey)).toMatchObject({ toolName: 'Write' });
    const endedFrame = await relay.waitForFrame(ofType('session.ended', sessionId));
    expect(endedFrame.status).toBe('done');
  });
});
