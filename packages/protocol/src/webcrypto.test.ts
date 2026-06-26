import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { encodeKey } from './crypto';
import { ProtocolError } from './errors';
import {
  deriveSharedKey,
  exportContentKey,
  exportIdentityPublicKey,
  generateContentKey,
  generateIdentityKeyPair,
  importContentKey,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  openPayload,
  sealPayload,
} from './webcrypto';

/**
 * Phase 4 Task 5 — the WebCrypto E2E primitives (ECDH X25519 → HKDF-SHA256 → AES-256-GCM) that replace
 * tweetnacl box/secretbox for the session path. These run in Node's Web Crypto (the same API the browser
 * exposes), and must: agree a shared key both directions, authenticate (reject tamper / wrong key),
 * import the daemon's existing raw tweetnacl keys unchanged, and keep a non-extractable private key
 * truly unreadable.
 */
describe('webcrypto E2E primitives (Phase 4 Task 5)', () => {
  it('two parties derive the same shared key and seal/open round-trips', async () => {
    const a = await generateIdentityKeyPair(true);
    const b = await generateIdentityKeyPair(true);
    const keyA = await deriveSharedKey(a.privateKey, b.publicKey);
    const keyB = await deriveSharedKey(b.privateKey, a.publicKey);

    const sealed = await sealPayload({ hello: 'world', n: 42 }, keyA);
    expect(typeof sealed.payload).toBe('string');
    expect(sealed.nonce).not.toBe('');
    expect(await openPayload(sealed, keyB)).toEqual({ hello: 'world', n: 42 });
  });

  it('a content key round-trips through export/import and seals the stream', async () => {
    const contentKey = await generateContentKey(true);
    const raw = await exportContentKey(contentKey);
    const reimported = await importContentKey(raw, false);

    const sealed = await sealPayload({ text: 'streamed frame' }, contentKey);
    expect(await openPayload(sealed, reimported)).toEqual({ text: 'streamed frame' });
  });

  it('rejects a tampered ciphertext (GCM authenticates before decrypting)', async () => {
    const key = await generateContentKey(true);
    const sealed = await sealPayload({ secret: 1 }, key);
    // Flip a byte of the base64 ciphertext.
    const bytes = Buffer.from(sealed.payload, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { payload: bytes.toString('base64'), nonce: sealed.nonce };
    await expect(openPayload(tampered, key)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rejects opening under the wrong key', async () => {
    const a = await generateIdentityKeyPair(true);
    const b = await generateIdentityKeyPair(true);
    const c = await generateIdentityKeyPair(true);
    const sealed = await sealPayload({ x: 1 }, await deriveSharedKey(a.privateKey, b.publicKey));
    // c is not the counterparty, so its shared key with a differs.
    const wrong = await deriveSharedKey(a.privateKey, c.publicKey);
    await expect(openPayload(sealed, wrong)).rejects.toBeInstanceOf(ProtocolError);
  });

  it("imports the daemon's existing raw tweetnacl keys unchanged (no re-pairing)", async () => {
    // The daemon stores a tweetnacl box keypair as raw base64 today; it must keep working under WebCrypto.
    const nk = nacl.box.keyPair();
    const daemonPriv = await importIdentityPrivateKey(encodeKey(nk.secretKey));
    const daemonPub = await importIdentityPublicKey(encodeKey(nk.publicKey));

    const browser = await generateIdentityKeyPair(true);
    const daemonShared = await deriveSharedKey(daemonPriv, browser.publicKey);
    const browserShared = await deriveSharedKey(browser.privateKey, daemonPub);

    const sealed = await sealPayload({ prompt: 'do it' }, browserShared);
    expect(await openPayload(sealed, daemonShared)).toEqual({ prompt: 'do it' });
  });

  it('rejects a private key that is not 32 bytes', async () => {
    await expect(importIdentityPrivateKey(encodeKey(new Uint8Array(16)))).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it('a non-extractable private key still derives but cannot be exported', async () => {
    const kp = await generateIdentityKeyPair(false);
    // It can still do ECDH...
    const peer = await generateIdentityKeyPair(true);
    await expect(deriveSharedKey(kp.privateKey, peer.publicKey)).resolves.toBeDefined();
    // ...but the raw private bytes can never be read out (the XSS-resistance guarantee).
    await expect(crypto.subtle.exportKey('pkcs8', kp.privateKey)).rejects.toBeDefined();
    // The public key is always exportable (it is public).
    expect(typeof (await exportIdentityPublicKey(kp.publicKey))).toBe('string');
  });

  it('models the full handshake: launch seal + content-key wrap + stream, end to end', async () => {
    // Daemon identity (persisted), browser identity (ephemeral/non-extractable in real use).
    const daemon = await generateIdentityKeyPair(true);
    const browser = await generateIdentityKeyPair(false);
    const daemonPubB64 = await exportIdentityPublicKey(daemon.publicKey);
    const browserPubB64 = await exportIdentityPublicKey(browser.publicKey);

    // 1. Browser seals the launch to the daemon.
    const launchKey = await deriveSharedKey(
      browser.privateKey,
      await importIdentityPublicKey(daemonPubB64),
    );
    const sealedLaunch = await sealPayload({ prompt: 'build it' }, launchKey);
    // Daemon opens it using the browser's announced pubkey.
    const daemonLaunchKey = await deriveSharedKey(
      daemon.privateKey,
      await importIdentityPublicKey(browserPubB64),
    );
    expect(await openPayload(sealedLaunch, daemonLaunchKey)).toEqual({ prompt: 'build it' });

    // 2. Daemon mints a content key and wraps it (its bytes) to the browser.
    const contentKey = await generateContentKey(true);
    const wrapped = await sealPayload({ key: await exportContentKey(contentKey) }, daemonLaunchKey);
    const unwrapped = (await openPayload(wrapped, launchKey)) as { key: string };
    const browserContentKey = await importContentKey(unwrapped.key, false);

    // 3. Daemon streams a frame under the content key; the browser decrypts it.
    const frame = await sealPayload({ text: 'Working on it' }, contentKey);
    expect(await openPayload(frame, browserContentKey)).toEqual({ text: 'Working on it' });
  });
});
