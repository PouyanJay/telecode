import {
  deriveSharedKey,
  exportContentKey,
  exportIdentityPublicKey,
  generateContentKey,
  generateIdentityKeyPair,
  importIdentityPublicKey,
  makeEnvelope,
  openPayload,
  sealPayload,
  type CryptoKeyHandle,
  type CryptoKeyPairHandle,
  type EncryptedEnvelopeFields,
  type Envelope,
} from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { loadOrCreateIdentityKeyPair, type IdentityKeyStore } from './keystore';
import { createBrowserSessionCipher } from './session-cipher';

/**
 * The browser side of the E2E session cipher (Phase 4 WebCrypto migration): it seals the launch to the
 * daemon's public key, unwraps the per-session content key the daemon delivers (`session.key`), encrypts
 * follow-ups under that key, and decrypts the streamed frames — the mirror of the daemon's
 * `session-cipher`. Tested against the real `@telecode/protocol` WebCrypto primitives, playing the daemon
 * with a known identity keypair.
 */
const sessionEnvelope = (type: string, fields: { payload: unknown; nonce: string }): Envelope =>
  makeEnvelope({
    type: type as Envelope['type'],
    userId: 'u',
    deviceId: 'd',
    sessionId: 's',
    payload: fields.payload,
    nonce: fields.nonce,
  });

// These scenarios only need a working identity, not persistence — inject a fresh non-extractable keypair
// so they don't reach for IndexedDB (the default factory, exercised by the persistence test below).
const browserCipher = (daemonPublicKey: string): ReturnType<typeof createBrowserSessionCipher> =>
  createBrowserSessionCipher(daemonPublicKey, () => generateIdentityKeyPair(false));

/** Play the daemon: wrap a content key to the browser's announced public key (`session.key` fields). */
async function daemonWrapKey(
  daemonPrivateKey: CryptoKeyHandle,
  browserPublicKeyB64: string,
  contentKey: CryptoKeyHandle,
): Promise<EncryptedEnvelopeFields> {
  const shared = await deriveSharedKey(
    daemonPrivateKey,
    await importIdentityPublicKey(browserPublicKeyB64),
  );
  return sealPayload({ key: await exportContentKey(contentKey) }, shared);
}

describe('browser session cipher', () => {
  it('seals a launch the daemon can open, announcing the browser public key', async () => {
    const daemon = await generateIdentityKeyPair(true);
    const cipher = browserCipher(await exportIdentityPublicKey(daemon.publicKey));

    const sealed = await cipher.sealLaunch({ prompt: 'do the thing' });
    expect(JSON.stringify(sealed)).not.toContain('do the thing');

    // The daemon derives the same shared key from the announced browser pubkey and opens the launch.
    const shared = await deriveSharedKey(
      daemon.privateKey,
      await importIdentityPublicKey(sealed.senderPublicKey),
    );
    expect(await openPayload({ payload: sealed.payload, nonce: sealed.nonce }, shared)).toEqual({
      prompt: 'do the thing',
    });
  });

  it('unwraps the delivered content key and decrypts a streamed frame', async () => {
    const daemon = await generateIdentityKeyPair(true);
    const cipher = browserCipher(await exportIdentityPublicKey(daemon.publicKey));
    const browserPublicKey = await cipher.publicKey();
    expect(browserPublicKey).toBeDefined();

    // Daemon mints a content key and wraps it to the browser's announced pubkey.
    const contentKey = await generateContentKey(true);
    const wrapped = await daemonWrapKey(daemon.privateKey, browserPublicKey!, contentKey);
    await cipher.receiveKey(sessionEnvelope('session.key', wrapped));
    expect(cipher.isEncrypted('s')).toBe(true);

    // A streamed frame encrypted under the content key decrypts to plaintext.
    const frame = sessionEnvelope('agent.message', await sealPayload({ text: 'hi' }, contentKey));
    expect(await cipher.tryDecrypt(frame)).toEqual({ decrypted: true, payload: { text: 'hi' } });
  });

  it('encrypts a follow-up under the session content key (daemon can open it)', async () => {
    const daemon = await generateIdentityKeyPair(true);
    const cipher = browserCipher(await exportIdentityPublicKey(daemon.publicKey));
    const browserPublicKey = await cipher.publicKey();
    const contentKey = await generateContentKey(true);
    const wrapped = await daemonWrapKey(daemon.privateKey, browserPublicKey!, contentKey);
    await cipher.receiveKey(sessionEnvelope('session.key', wrapped));

    const sealed = await cipher.encrypt('s', { text: 'follow up' });
    expect(JSON.stringify(sealed)).not.toContain('follow up');
    // The daemon decrypts it with the same content key (symmetric).
    expect(await openPayload(sealed, contentKey)).toEqual({ text: 'follow up' });
  });

  it('passes a cleartext frame through (empty nonce — e.g. a relay-generated message)', async () => {
    const daemon = await generateIdentityKeyPair(true);
    const cipher = browserCipher(await exportIdentityPublicKey(daemon.publicKey));
    const frame = makeEnvelope({
      type: 'session.ended',
      userId: 'u',
      deviceId: 'd',
      sessionId: 's',
      status: 'error',
      payload: { status: 'error', error: 'device offline' },
    });
    expect(await cipher.tryDecrypt(frame)).toEqual({ decrypted: false });
  });

  it('throws on a tampered encrypted frame instead of passing it through as cleartext', async () => {
    const daemon = await generateIdentityKeyPair(true);
    const cipher = browserCipher(await exportIdentityPublicKey(daemon.publicKey));
    const browserPublicKey = await cipher.publicKey();
    const contentKey = await generateContentKey(true);
    const wrapped = await daemonWrapKey(daemon.privateKey, browserPublicKey!, contentKey);
    await cipher.receiveKey(sessionEnvelope('session.key', wrapped));

    // A bit-flipped ciphertext (string payload + nonce + a known key) must fail authentication, not be
    // mistaken for a cleartext frame and surfaced raw to the UI.
    const sealed = await sealPayload({ text: 'secret' }, contentKey);
    const tampered = sessionEnvelope('agent.message', {
      payload: `${sealed.payload[0] === 'A' ? 'B' : 'A'}${sealed.payload.slice(1)}`,
      nonce: sealed.nonce,
    });
    await expect(cipher.tryDecrypt(tampered)).rejects.toThrow();
  });

  it('is disabled when there is no daemon public key (pre-E2E device)', async () => {
    const cipher = createBrowserSessionCipher(null);
    expect(cipher.enabled).toBe(false);
    expect(await cipher.publicKey()).toBeUndefined();
  });

  it('ignores a session.key it cannot unwrap (a cache replay wrapped to another browser) — Phase 4 T8', async () => {
    const daemon = await generateIdentityKeyPair(true);
    const cipher = browserCipher(await exportIdentityPublicKey(daemon.publicKey));

    // The relay may replay a cached session.key wrapped to a DIFFERENT browser; this cipher can't open it.
    const otherBrowser = await generateIdentityKeyPair(true);
    const contentKey = await generateContentKey(true);
    const wrappedForOther = await daemonWrapKey(
      daemon.privateKey,
      await exportIdentityPublicKey(otherBrowser.publicKey),
      contentKey,
    );

    // It must be ignored (no throw, no wrong key established) — the daemon delivers one wrapped to us.
    await expect(
      cipher.receiveKey(sessionEnvelope('session.key', wrappedForOther)),
    ).resolves.toBeUndefined();
    expect(cipher.isEncrypted('s')).toBe(false);
  });

  it('reuses the persisted identity across reopens — a stable browser public key (Phase 4 T7)', async () => {
    // A shared keystore stands in for IndexedDB surviving a reload.
    const map = new Map<string, CryptoKeyPairHandle>();
    const store: IdentityKeyStore = {
      get: (id) => Promise.resolve(map.get(id)),
      put: (id, kp) => {
        map.set(id, kp);
        return Promise.resolve();
      },
    };
    const factory = (): Promise<CryptoKeyPairHandle> => loadOrCreateIdentityKeyPair(store);
    const daemonPub = await exportIdentityPublicKey(
      (await generateIdentityKeyPair(true)).publicKey,
    );

    const before = createBrowserSessionCipher(daemonPub, factory);
    const firstKey = await before.publicKey();
    // A "reopen": a brand-new cipher backed by the same persisted keystore.
    const after = createBrowserSessionCipher(daemonPub, factory);

    expect(await after.publicKey()).toBe(firstKey);
  });
});
