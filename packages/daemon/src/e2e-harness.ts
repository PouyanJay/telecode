import { randomUUID } from 'node:crypto';

import {
  deriveSharedKey,
  encodeKey,
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
} from '@telecode/protocol';

import { type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon, type DaemonOptions } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Test-only helper (not part of the package's public API): the browser side of an E2E-encrypted
 * daemon session, simulated over WebCrypto exactly as the real web cipher does it — plus the daemon
 * bootstrap that pairs with it. Shared by every daemon test that drives real session crypto
 * (`daemon.e2e.test.ts`, `daemon.meta.test.ts`, …) so the handshake plumbing lives once.
 */
export interface E2eIds {
  userId: string;
  deviceId: string;
  sessionId: string;
}

export function mkE2eIds(): E2eIds {
  return { userId: randomUUID(), deviceId: randomUUID(), sessionId: randomUUID() };
}

/** The sealed fields of a frame under inspection (an {@link Envelope} narrows to this). */
export type SealedFields = { readonly payload?: unknown; readonly nonce: string };

/** Start a fake relay + a keypair-bearing daemon on it. The caller owns cleanup of both. */
export async function startE2eDaemon(options: {
  ids: Pick<E2eIds, 'userId' | 'deviceId'>;
  daemonKeyPair: KeyPair;
  agentAdapter: AgentAdapter;
  extras?: Partial<DaemonOptions>;
}): Promise<{ daemon: Daemon; relay: FakeRelay }> {
  const relay = await startFakeRelay(options.ids.userId, options.ids.deviceId);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId: options.ids.userId,
    deviceId: options.ids.deviceId,
    keyPair: {
      publicKey: encodeKey(options.daemonKeyPair.publicKey),
      privateKey: encodeKey(options.daemonKeyPair.privateKey),
    },
    agentAdapter: options.agentAdapter,
    ...options.extras,
  });
  await daemon.start();
  return { daemon, relay };
}

/** Box-seal a payload from one peer to another (ECDH → HKDF → AES-GCM), as the browser seals a launch. */
export async function sealEnvelopePayload(
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

/** Open a `session.key` frame wrapped to the browser and return the base64 content key. */
export async function unwrapContentKey(
  frame: SealedFields,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<string> {
  const shared = await deriveSharedKey(
    await importIdentityPrivateKey(encodeKey(recipientPrivateKey)),
    await importIdentityPublicKey(encodeKey(senderPublicKey)),
  );
  return sessionKeyPayloadSchema.parse(await openPayload(frame, shared)).key;
}

/** Seal a payload under the per-session content key, as the browser seals decisions/follow-ups. */
export async function encryptWithContentKey(
  payload: unknown,
  contentKey: string,
): Promise<EncryptedEnvelopeFields> {
  return sealPayload(payload, await importContentKey(contentKey, false));
}

/** Open a stream frame sealed under the per-session content key. */
export async function decryptWithContentKey(
  frame: SealedFields,
  contentKey: string,
): Promise<unknown> {
  return openPayload(frame, await importContentKey(contentKey, false));
}

/** Browser-side: seal a launch to the daemon and send it with the browser's ephemeral pubkey announced. */
export async function sendSealedLaunch(
  relay: FakeRelay,
  ids: E2eIds,
  daemonKeyPair: KeyPair,
  browserKeyPair: KeyPair,
  launch: Record<string, unknown>,
): Promise<void> {
  const sealed = await sealEnvelopePayload(
    launch,
    daemonKeyPair.publicKey,
    browserKeyPair.privateKey,
  );
  relay.send(
    makeEnvelope({
      type: 'session.launch',
      userId: ids.userId,
      deviceId: ids.deviceId,
      sessionId: ids.sessionId,
      senderPublicKey: encodeKey(browserKeyPair.publicKey),
      payload: sealed.payload,
      nonce: sealed.nonce,
    }),
  );
}

/** Browser-side: a cleartext subscribe announcing a pubkey, so the daemon (re-)delivers the content key. */
export function sendSubscribe(relay: FakeRelay, ids: E2eIds, senderPublicKey: string): void {
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

/** Frame predicate for {@link FakeRelay.waitForFrame}: one message type for one session. */
export const ofType =
  (type: string, sessionId: string) =>
  (e: Envelope): boolean =>
    e.type === type && e.session_id === sessionId;
