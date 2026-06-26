import { randomUUID } from 'node:crypto';

import {
  deriveSharedKey,
  encodeKey,
  generateKeyPair,
  importContentKey,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  makeEnvelope,
  openPayload,
  sealPayload,
  sessionKeyPayloadSchema,
  type EncryptedEnvelopeFields,
  type Envelope,
  type KeyPair,
  type MessageType,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Browser-side E2E simulation over WebCrypto (Phase 4) — mirrors what the real browser cipher does, with
 * the same shapes the old tweetnacl helpers had so the scenarios below read unchanged. The daemon's
 * keypair is generated with tweetnacl (raw X25519) and imported into WebCrypto here, exactly as the
 * daemon does — proving the AES-GCM handshake interoperates with the daemon's stored keys.
 */
type SealedFields = { readonly payload?: unknown; readonly nonce: string };

async function sealEnvelopePayload(
  payload: unknown,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array,
): Promise<EncryptedEnvelopeFields> {
  const shared = await deriveSharedKey(
    await importIdentityPrivateKey(encodeKey(senderPrivateKey)),
    await importIdentityPublicKey(encodeKey(recipientPublicKey)),
  );
  return sealPayload(payload, shared);
}

async function unwrapContentKey(
  envelope: SealedFields,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<string> {
  const shared = await deriveSharedKey(
    await importIdentityPrivateKey(encodeKey(recipientPrivateKey)),
    await importIdentityPublicKey(encodeKey(senderPublicKey)),
  );
  return sessionKeyPayloadSchema.parse(await openPayload(envelope, shared)).key;
}

async function encryptWithContentKey(
  payload: unknown,
  contentKey: string,
): Promise<EncryptedEnvelopeFields> {
  return sealPayload(payload, await importContentKey(contentKey, false));
}

async function decryptWithContentKey(envelope: SealedFields, contentKey: string): Promise<unknown> {
  return openPayload(envelope, await importContentKey(contentKey, false));
}

/**
 * Phase 3 daemon-side E2E. A keypair-bearing daemon must: decrypt a `session.launch` sealed (box) to its
 * public key, mint a per-session content key, deliver it (`session.key`, box-wrapped to the browser's
 * ephemeral key), encrypt every outbound stream frame under that content key (secretbox), and decrypt
 * encrypted inbound frames. The relay (here the fake relay) only ever forwards ciphertext. The test acts
 * as the browser: it holds an ephemeral keypair + the daemon pubkey. Task 11 adds the variant matrix
 * (follow-ups, controls, reconnect/multi-browser, tampered frames, error state).
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

interface Ids {
  userId: string;
  deviceId: string;
  sessionId: string;
}

function mkIds(): Ids {
  return { userId: randomUUID(), deviceId: randomUUID(), sessionId: randomUUID() };
}

async function startE2eDaemon(
  userId: string,
  deviceId: string,
  daemonKp: KeyPair,
  agentAdapter: AgentAdapter,
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
    agentAdapter,
    logger: silent,
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

/** Browser-side: seal a launch to the daemon and send it with the browser's ephemeral pubkey announced. */
async function sendSealedLaunch(
  relay: FakeRelay,
  ids: Ids,
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

/** Launch a session and return the content key the daemon delivered (`session.key`, box-wrapped). */
async function launchAndKey(
  relay: FakeRelay,
  ids: Ids,
  daemonKp: KeyPair,
  browserKp: KeyPair,
  prompt: string,
): Promise<string> {
  await sendSealedLaunch(relay, ids, daemonKp, browserKp, prompt);
  const keyFrame = await relay.waitForFrame(ofType('session.key', ids.sessionId));
  return unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);
}

/** Browser-side: send a secretbox-encrypted frame under the content key (follow-up / decision / control). */
async function sendEncrypted(
  relay: FakeRelay,
  type: MessageType,
  ids: Ids,
  contentKey: string,
  payload: unknown,
): Promise<void> {
  const sealed = await encryptWithContentKey(payload, contentKey);
  relay.send(
    makeEnvelope({
      type,
      userId: ids.userId,
      deviceId: ids.deviceId,
      sessionId: ids.sessionId,
      payload: sealed.payload,
      nonce: sealed.nonce,
    }),
  );
}

/** Browser-side: a cleartext subscribe announcing a pubkey, so the daemon re-delivers the content key. */
function sendSubscribe(relay: FakeRelay, ids: Ids, senderPublicKey: string): void {
  relay.send(
    makeEnvelope({
      type: 'session.subscribe',
      userId: ids.userId,
      deviceId: ids.deviceId,
      sessionId: ids.sessionId,
      senderPublicKey,
      payload: {},
    }),
  );
}

const ofType = (type: string, sessionId: string) => (e: Envelope) =>
  e.type === type && e.session_id === sessionId;

const fakeAdapter = (events: Parameters<typeof createFakeAgentAdapter>[0]): AgentAdapter =>
  createFakeAgentAdapter(events, { sessionId: 'sdk-1' });

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('daemon E2E encryption (Task 6)', () => {
  it('decrypts the launch, delivers the session key, and encrypts the stream', async () => {
    const ids = mkIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startE2eDaemon(
      ids.userId,
      ids.deviceId,
      daemonKp,
      fakeAdapter([{ type: 'message', text: 'planning the change' }]),
    );

    const PROMPT = 'delete all production data';
    await sendSealedLaunch(relay, ids, daemonKp, browserKp, PROMPT);

    // 1. The daemon delivers the content key, box-wrapped to the browser's ephemeral pubkey: the key
    //    itself travels as opaque ciphertext (a base64 string), never plaintext.
    const keyFrame = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    expect(JSON.stringify(keyFrame)).not.toContain(PROMPT);
    expect(typeof keyFrame.payload).toBe('string');
    expect(keyFrame.nonce).not.toBe('');
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);

    // 2. Even session.started (carrying only the correlation ref) is sealed under the content key.
    const startedFrame = await relay.waitForFrame(ofType('session.started', ids.sessionId));
    expect(typeof startedFrame.payload).toBe('string');

    // 3. The streamed frames are ciphertext under the content key; the browser decrypts them.
    const messageFrame = await relay.waitForFrame(ofType('agent.message', ids.sessionId));
    expect(typeof messageFrame.payload).toBe('string');
    expect(JSON.stringify(messageFrame)).not.toContain('planning the change');
    expect(await decryptWithContentKey(messageFrame, contentKey)).toEqual({
      text: 'planning the change',
    });

    // 4. session.ended carries the cleartext status (for the relay) AND the encrypted payload.
    const endedFrame = await relay.waitForFrame(ofType('session.ended', ids.sessionId));
    expect(endedFrame.status).toBe('done');
    expect(await decryptWithContentKey(endedFrame, contentKey)).toMatchObject({ status: 'done' });
  });

  it('decrypts an encrypted permission decision and runs the gated tool', async () => {
    const ids = mkIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startE2eDaemon(
      ids.userId,
      ids.deviceId,
      daemonKp,
      fakeAdapter([{ type: 'tool_use', toolName: 'Write', input: { path: 'README.md' } }]),
    );

    const contentKey = await launchAndKey(relay, ids, daemonKp, browserKp, 'write a file');

    // The gate request is encrypted; the browser decrypts it to read the correlation id.
    const requestFrame = await relay.waitForFrame(
      ofType('agent.permission_request', ids.sessionId),
    );
    expect(typeof requestFrame.payload).toBe('string');
    const request = (await decryptWithContentKey(requestFrame, contentKey)) as {
      requestId: string;
    };

    // The browser replies with an ENCRYPTED decision; the daemon must decrypt it to act.
    await sendEncrypted(relay, 'permission.decision', ids, contentKey, {
      requestId: request.requestId,
      behavior: 'allow',
    });

    // The decision was decrypted → the gated tool ran (its use streams, encrypted) and the session ended.
    const toolFrame = await relay.waitForFrame(ofType('agent.tool_use', ids.sessionId));
    expect(await decryptWithContentKey(toolFrame, contentKey)).toMatchObject({ toolName: 'Write' });
    const endedFrame = await relay.waitForFrame(ofType('session.ended', ids.sessionId));
    expect(endedFrame.status).toBe('done');
  });
});

describe('daemon E2E variants (Task 11)', () => {
  it('decrypts an encrypted user.message follow-up and runs a second turn', async () => {
    const ids = mkIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startE2eDaemon(
      ids.userId,
      ids.deviceId,
      daemonKp,
      fakeAdapter([{ type: 'message', text: 'turn output' }]),
    );
    const contentKey = await launchAndKey(relay, ids, daemonKp, browserKp, 'first task');
    await relay.waitForFrame(ofType('session.ended', ids.sessionId)); // turn 1 done

    // The follow-up is secretbox-encrypted; the daemon must decrypt it to resume a second turn.
    await sendEncrypted(relay, 'user.message', ids, contentKey, { text: 'second task' });
    await relay.waitForFrame(ofType('session.ended', ids.sessionId)); // turn 2 done — proves decrypt + resume

    // The decrypted follow-up was recorded: reconnect and read the encrypted transcript back.
    sendSubscribe(relay, ids, encodeKey(browserKp.publicKey));
    const keyFrame2 = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    const ck2 = await unwrapContentKey(keyFrame2, daemonKp.publicKey, browserKp.privateKey);
    const historyFrame = await relay.waitForFrame(ofType('session.history', ids.sessionId));
    const history = (await decryptWithContentKey(historyFrame, ck2)) as {
      entries: { kind: string; text?: string }[];
    };
    const prompts = history.entries.filter((e) => e.kind === 'user').map((e) => e.text);
    expect(prompts).toEqual(['first task', 'second task']);
  });

  it('decrypts an encrypted session.control (interrupt) and ends the turn with a cleartext status', async () => {
    const ids = mkIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startE2eDaemon(
      ids.userId,
      ids.deviceId,
      daemonKp,
      fakeAdapter([{ type: 'tool_use', toolName: 'Write', input: {} }]),
    );
    const contentKey = await launchAndKey(relay, ids, daemonKp, browserKp, 'gated task');
    await relay.waitForFrame(ofType('agent.permission_request', ids.sessionId)); // mid-session, gate open

    // The browser sends an ENCRYPTED interrupt; the daemon must decrypt it to abort the in-flight turn.
    await sendEncrypted(relay, 'session.control', ids, contentKey, { action: 'interrupt' });
    const endedFrame = await relay.waitForFrame(ofType('session.ended', ids.sessionId));
    expect(endedFrame.status).toBe('done'); // cleartext status the relay reads
    expect(await decryptWithContentKey(endedFrame, contentKey)).toMatchObject({ status: 'done' });
  });

  it('re-delivers the same content key to a second browser on subscribe (multi-tab fan-out)', async () => {
    const ids = mkIds();
    const daemonKp = await generateKeyPair();
    const browserA = await generateKeyPair();
    const browserB = await generateKeyPair();
    const relay = await startE2eDaemon(
      ids.userId,
      ids.deviceId,
      daemonKp,
      fakeAdapter([{ type: 'message', text: 'output' }]),
    );
    const keyA = await launchAndKey(relay, ids, daemonKp, browserA, 'task');
    await relay.waitForFrame(ofType('session.ended', ids.sessionId));

    // A second browser (a different ephemeral key) reconnects and announces its pubkey.
    sendSubscribe(relay, ids, encodeKey(browserB.publicKey));
    const keyFrameB = await relay.waitForFrame(ofType('session.key', ids.sessionId));
    const keyB = await unwrapContentKey(keyFrameB, daemonKp.publicKey, browserB.privateKey);
    // The decisive property: the SAME content key, wrapped to a different browser — so one broadcast
    // frame decrypts for every tab.
    expect(keyB).toBe(keyA);

    const historyFrame = await relay.waitForFrame(ofType('session.history', ids.sessionId));
    expect(await decryptWithContentKey(historyFrame, keyB)).toMatchObject({ status: 'done' });
  });

  it('drops a tampered inbound frame and still processes a valid one', async () => {
    const ids = mkIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const relay = await startE2eDaemon(
      ids.userId,
      ids.deviceId,
      daemonKp,
      fakeAdapter([{ type: 'tool_use', toolName: 'Write', input: { path: 'README.md' } }]),
    );
    const contentKey = await launchAndKey(relay, ids, daemonKp, browserKp, 'write a file');
    const reqFrame = await relay.waitForFrame(ofType('agent.permission_request', ids.sessionId));
    const req = (await decryptWithContentKey(reqFrame, contentKey)) as { requestId: string };

    // A tampered decision (bit-flipped ciphertext) must be dropped — never crash the daemon.
    const sealed = await encryptWithContentKey(
      { requestId: req.requestId, behavior: 'allow' },
      contentKey,
    );
    const flipped = `${sealed.payload[0] === 'A' ? 'B' : 'A'}${sealed.payload.slice(1)}`;
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId: ids.userId,
        deviceId: ids.deviceId,
        sessionId: ids.sessionId,
        payload: flipped,
        nonce: sealed.nonce,
      }),
    );

    // A subsequent valid decision still runs the gated tool → the daemon survived the tampered frame.
    await sendEncrypted(relay, 'permission.decision', ids, contentKey, {
      requestId: req.requestId,
      behavior: 'allow',
    });
    const toolFrame = await relay.waitForFrame(ofType('agent.tool_use', ids.sessionId));
    expect(await decryptWithContentKey(toolFrame, contentKey)).toMatchObject({ toolName: 'Write' });
    await relay.waitForFrame(ofType('session.ended', ids.sessionId));
  });

  it('ends a failed turn with a cleartext error status and an encrypted payload', async () => {
    const ids = mkIds();
    const daemonKp = await generateKeyPair();
    const browserKp = await generateKeyPair();
    const failing: AgentAdapter = { run: () => Promise.reject(new Error('agent crashed')) };
    const relay = await startE2eDaemon(ids.userId, ids.deviceId, daemonKp, failing);
    const contentKey = await launchAndKey(relay, ids, daemonKp, browserKp, 'will fail');

    const endedFrame = await relay.waitForFrame(ofType('session.ended', ids.sessionId));
    expect(endedFrame.status).toBe('error'); // cleartext status for the relay
    expect(await decryptWithContentKey(endedFrame, contentKey)).toMatchObject({ status: 'error' });
  });
});
