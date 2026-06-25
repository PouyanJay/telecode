import {
  decodeKey,
  decryptWithContentKey,
  encodeKey,
  encryptWithContentKey,
  generateContentKey,
  generateKeyPair,
  makeEnvelope,
  openEnvelopePayload,
  wrapContentKey,
  type Envelope,
} from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { createBrowserSessionCipher } from './session-cipher';

/**
 * The browser side of the E2E session cipher (Phase 3, Task 7): it seals the launch to the daemon's
 * public key, unwraps the per-session content key the daemon delivers (`session.key`), encrypts follow-ups
 * under that key, and decrypts the streamed frames — the mirror of the daemon's `session-cipher`. Tested
 * against the real `@telecode/protocol` crypto, playing the daemon with a known keypair.
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

describe('browser session cipher', () => {
  it('seals a launch the daemon can open, announcing the browser public key', async () => {
    const daemon = await generateKeyPair();
    const cipher = createBrowserSessionCipher(encodeKey(daemon.publicKey));

    const sealed = await cipher.sealLaunch({ prompt: 'do the thing' });
    expect(JSON.stringify(sealed)).not.toContain('do the thing');

    const opened = await openEnvelopePayload(
      { payload: sealed.payload, nonce: sealed.nonce },
      decodeKey(sealed.senderPublicKey),
      daemon.privateKey,
    );
    expect(opened).toEqual({ prompt: 'do the thing' });
  });

  it('unwraps the delivered content key and decrypts a streamed frame', async () => {
    const daemon = await generateKeyPair();
    const cipher = createBrowserSessionCipher(encodeKey(daemon.publicKey));
    const browserPublicKey = await cipher.publicKey();
    expect(browserPublicKey).toBeDefined();

    // Daemon mints a content key and box-wraps it to the browser's announced pubkey.
    const contentKey = generateContentKey();
    const wrapped = await wrapContentKey(
      contentKey,
      decodeKey(browserPublicKey!),
      daemon.privateKey,
    );
    await cipher.receiveKey(sessionEnvelope('session.key', wrapped));
    expect(cipher.isEncrypted('s')).toBe(true);

    // A streamed frame encrypted under the content key decrypts to plaintext.
    const frame = sessionEnvelope(
      'agent.message',
      await encryptWithContentKey({ text: 'hi' }, contentKey),
    );
    expect(await cipher.tryDecrypt(frame)).toEqual({ decrypted: true, payload: { text: 'hi' } });
  });

  it('encrypts a follow-up under the session content key (daemon can open it)', async () => {
    const daemon = await generateKeyPair();
    const cipher = createBrowserSessionCipher(encodeKey(daemon.publicKey));
    const browserPublicKey = await cipher.publicKey();
    const contentKey = generateContentKey();
    const wrapped = await wrapContentKey(
      contentKey,
      decodeKey(browserPublicKey!),
      daemon.privateKey,
    );
    await cipher.receiveKey(sessionEnvelope('session.key', wrapped));

    const sealed = await cipher.encrypt('s', { text: 'follow up' });
    expect(JSON.stringify(sealed)).not.toContain('follow up');
    // The daemon decrypts it with the same content key (symmetric).
    expect(await decryptWithContentKey(sealed, contentKey)).toEqual({ text: 'follow up' });
  });

  it('passes a cleartext frame through (empty nonce — e.g. a relay-generated message)', async () => {
    const daemon = await generateKeyPair();
    const cipher = createBrowserSessionCipher(encodeKey(daemon.publicKey));
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
    const daemon = await generateKeyPair();
    const cipher = createBrowserSessionCipher(encodeKey(daemon.publicKey));
    const browserPublicKey = await cipher.publicKey();
    const contentKey = generateContentKey();
    const wrapped = await wrapContentKey(
      contentKey,
      decodeKey(browserPublicKey!),
      daemon.privateKey,
    );
    await cipher.receiveKey(sessionEnvelope('session.key', wrapped));

    // A bit-flipped ciphertext (string payload + nonce + a known key) must fail authentication, not be
    // mistaken for a cleartext frame and surfaced raw to the UI.
    const sealed = await encryptWithContentKey({ text: 'secret' }, contentKey);
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
});
