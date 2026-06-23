import { beforeAll, describe, expect, it } from 'vitest';

import { generateKeyPair, open, ready, seal } from './crypto';

describe('crypto (libsodium crypto_box round-trip)', () => {
  beforeAll(async () => {
    await ready();
  });

  it('generates 32-byte X25519 keypairs', async () => {
    const kp = await generateKeyPair();
    expect(kp.publicKey).toHaveLength(32);
    expect(kp.privateKey).toHaveLength(32);
  });

  it('seals and opens a message between two parties', async () => {
    const browser = await generateKeyPair();
    const daemon = await generateKeyPair();

    const sealed = await seal('launch session', daemon.publicKey, browser.privateKey);
    expect(sealed.ciphertext).not.toContain('launch session');

    const recovered = await open(sealed, browser.publicKey, daemon.privateKey);
    expect(recovered).toBe('launch session');
  });

  it('fails to open with the wrong recipient key', async () => {
    const browser = await generateKeyPair();
    const daemon = await generateKeyPair();
    const attacker = await generateKeyPair();

    const sealed = await seal('secret', daemon.publicKey, browser.privateKey);

    await expect(open(sealed, browser.publicKey, attacker.privateKey)).rejects.toThrow();
  });

  it('fails to open tampered ciphertext', async () => {
    const browser = await generateKeyPair();
    const daemon = await generateKeyPair();

    const sealed = await seal('secret', daemon.publicKey, browser.privateKey);
    const tampered = {
      ...sealed,
      ciphertext: sealed.ciphertext.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
    };

    await expect(open(tampered, browser.publicKey, daemon.privateKey)).rejects.toThrow();
  });
});
