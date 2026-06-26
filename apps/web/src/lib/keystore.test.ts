import {
  exportIdentityPublicKey,
  generateIdentityKeyPair,
  type CryptoKeyPairHandle,
} from '@telecode/protocol';
import { describe, expect, it, vi } from 'vitest';

import { loadOrCreateIdentityKeyPair, type IdentityKeyStore } from './keystore';

/**
 * Phase 4 Task 7 — the browser identity keystore. The load-or-create logic is tested against an in-memory
 * store (node has no IndexedDB; the real IndexedDB glue is thin and browser-verified). The point: one
 * non-extractable identity is generated once and reused across reopens, giving the browser a stable public
 * key — without which a same-device reload couldn't decrypt cached history.
 */
function memoryStore(): IdentityKeyStore {
  const map = new Map<string, CryptoKeyPairHandle>();
  return {
    get: (id) => Promise.resolve(map.get(id)),
    put: (id, keyPair) => {
      map.set(id, keyPair);
      return Promise.resolve();
    },
  };
}

describe('identity keystore (Phase 4 Task 7)', () => {
  it('generates and stores a keypair on first use, then reloads the SAME one (stable across reopen)', async () => {
    const store = memoryStore();
    const generate = vi.fn(() => generateIdentityKeyPair(false));

    const first = await loadOrCreateIdentityKeyPair(store, generate);
    const second = await loadOrCreateIdentityKeyPair(store, generate); // a "reopen"

    expect(generate).toHaveBeenCalledTimes(1); // generated once, then loaded
    expect(await exportIdentityPublicKey(first.publicKey)).toBe(
      await exportIdentityPublicKey(second.publicKey),
    );
  });

  it('persists a non-extractable keypair (the stored private key cannot be exported)', async () => {
    const keyPair = await loadOrCreateIdentityKeyPair(memoryStore());
    await expect(crypto.subtle.exportKey('pkcs8', keyPair.privateKey)).rejects.toBeDefined();
  });
});
