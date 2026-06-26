import { describe, expect, it } from 'vitest';

import { generateKeyPair } from './crypto';
import { ProtocolError } from './errors';
import {
  decryptWithContentKey,
  encryptWithContentKey,
  generateContentKey,
  unwrapContentKey,
  wrapContentKey,
} from './session-crypto';

/**
 * The per-session content-key model (plan §3.6, Phase 3 Q1): the daemon mints one symmetric content key
 * per session, wraps it (box) to each watching browser's ephemeral public key, and encrypts every payload
 * ONCE under that key. Because the relay broadcasts one identical frame to all browsers, the decisive
 * property is: a payload sealed once under the content key must decrypt for EVERY browser that unwrapped
 * the key — and for no one else.
 */
describe('per-session content key', () => {
  it('round-trips a payload encrypted once under the content key', async () => {
    const key = generateContentKey();
    const sealed = await encryptWithContentKey({ text: 'streamed agent output' }, key);
    expect(typeof sealed.payload).toBe('string');
    expect(JSON.stringify(sealed)).not.toContain('streamed agent output');
    expect(await decryptWithContentKey(sealed, key)).toEqual({ text: 'streamed agent output' });
  });

  it('uses a fresh nonce per encryption (same payload + key → different ciphertext)', async () => {
    const key = generateContentKey();
    const a = await encryptWithContentKey({ text: 'payload' }, key);
    const b = await encryptWithContentKey({ text: 'payload' }, key);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.payload).not.toBe(b.payload);
  });

  it('rejects a tampered ciphertext', async () => {
    const key = generateContentKey();
    const sealed = await encryptWithContentKey({ secret: 42 }, key);
    const tampered = { ...sealed, payload: `${sealed.payload.slice(0, -2)}AA` };
    await expect(decryptWithContentKey(tampered, key)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rejects decryption under a different content key', async () => {
    const sealed = await encryptWithContentKey({ secret: 'x' }, generateContentKey());
    await expect(decryptWithContentKey(sealed, generateContentKey())).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it('rejects a non-ciphertext payload before decrypting', async () => {
    await expect(
      decryptWithContentKey({ payload: { not: 'ciphertext' }, nonce: '' }, generateContentKey()),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('wraps to a browser pubkey and the browser unwraps the same key', async () => {
    const daemon = await generateKeyPair();
    const browser = await generateKeyPair();
    const key = generateContentKey();

    const wrapped = await wrapContentKey(key, browser.publicKey, daemon.privateKey);
    expect(JSON.stringify(wrapped)).not.toContain(key);
    expect(await unwrapContentKey(wrapped, daemon.publicKey, browser.privateKey)).toBe(key);
  });

  it('lets EVERY browser that unwrapped the key decrypt one broadcast payload (multi-tab)', async () => {
    const daemon = await generateKeyPair();
    const tabA = await generateKeyPair();
    const tabB = await generateKeyPair();
    const key = generateContentKey();

    // The daemon wraps the same content key to each tab's pubkey (one wrap per subscriber)...
    const forA = await wrapContentKey(key, tabA.publicKey, daemon.privateKey);
    const forB = await wrapContentKey(key, tabB.publicKey, daemon.privateKey);

    // ...and encrypts ONE payload that the relay broadcasts to both. Each tab unwraps its own copy of
    // the key and decrypts the shared frame with it — exactly the runtime flow, not the original key.
    const broadcast = await encryptWithContentKey({ text: 'fan-out frame' }, key);
    const keyAtTabA = await unwrapContentKey(forA, daemon.publicKey, tabA.privateKey);
    const keyAtTabB = await unwrapContentKey(forB, daemon.publicKey, tabB.privateKey);
    expect(await decryptWithContentKey(broadcast, keyAtTabA)).toEqual({ text: 'fan-out frame' });
    expect(await decryptWithContentKey(broadcast, keyAtTabB)).toEqual({ text: 'fan-out frame' });
  });

  it('does not let a non-subscribed browser unwrap the key', async () => {
    const daemon = await generateKeyPair();
    const subscriber = await generateKeyPair();
    const intruder = await generateKeyPair();
    const wrapped = await wrapContentKey(
      generateContentKey(),
      subscriber.publicKey,
      daemon.privateKey,
    );

    await expect(
      unwrapContentKey(wrapped, daemon.publicKey, intruder.privateKey),
    ).rejects.toThrow();
  });
});
