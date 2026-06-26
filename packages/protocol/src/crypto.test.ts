import { describe, expect, it } from 'vitest';

import { generateKeyPair, generateSecretKey, openSecret, sealSecret } from './crypto';

describe('crypto: X25519 keypair generation', () => {
  it('generates 32-byte X25519 keypairs (the daemon device identity)', async () => {
    const kp = await generateKeyPair();
    expect(kp.publicKey).toHaveLength(32);
    expect(kp.privateKey).toHaveLength(32);
  });
});

describe('secretbox (symmetric at-rest encryption — the relay OAuth-token store)', () => {
  it('generates a 32-byte secret key', () => {
    expect(generateSecretKey()).toHaveLength(32);
  });

  it('seals and opens with the same key, hiding the plaintext', async () => {
    const key = generateSecretKey();

    const sealed = await sealSecret('gho_secret_access_token', key);
    expect(sealed.ciphertext).not.toContain('gho_secret_access_token');
    expect(sealed.nonce).not.toBe('');

    expect(await openSecret(sealed, key)).toBe('gho_secret_access_token');
  });

  it('uses a fresh nonce per seal (same plaintext + key → different ciphertext)', async () => {
    const key = generateSecretKey();
    const a = await sealSecret('same', key);
    const b = await sealSecret('same', key);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails to open with the wrong key', async () => {
    const sealed = await sealSecret('secret', generateSecretKey());
    await expect(openSecret(sealed, generateSecretKey())).rejects.toThrow();
  });

  it('fails to open tampered ciphertext', async () => {
    const key = generateSecretKey();
    const sealed = await sealSecret('secret', key);
    const tampered = {
      ...sealed,
      ciphertext: sealed.ciphertext.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
    };
    await expect(openSecret(tampered, key)).rejects.toThrow();
  });
});
