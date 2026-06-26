import { exportIdentityPublicKey, type CryptoKeyPairHandle } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { loadOrCreateIdentityKeyPair, type IdentityKeyStore } from './keystore';

/**
 * Phase 4 variant coverage (T16) for browser-key persistence (T7). Parametrizes the three identities a
 * user can encounter: a reopen on the same device (same store → same key → cached history decrypts), a
 * second browser (separate store → a distinct identity), and a cleared IndexedDB (the key is gone →
 * a fresh identity is generated). The DI'd in-memory store stands in for IndexedDB.
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

const pub = (kp: CryptoKeyPairHandle) => exportIdentityPublicKey(kp.publicKey);

describe('browser key persistence variants (T16)', () => {
  it('same device reopen reuses one stable identity', async () => {
    const store = memoryStore();
    const first = await loadOrCreateIdentityKeyPair(store);
    const reopened = await loadOrCreateIdentityKeyPair(store);
    expect(await pub(first)).toBe(await pub(reopened));
  });

  it('a second browser (separate store) gets a distinct identity', async () => {
    const here = await loadOrCreateIdentityKeyPair(memoryStore());
    const otherBrowser = await loadOrCreateIdentityKeyPair(memoryStore());
    expect(await pub(here)).not.toBe(await pub(otherBrowser));
  });

  it('clearing IndexedDB forces a fresh identity on next open', async () => {
    const store = memoryStore();
    const before = await loadOrCreateIdentityKeyPair(store);
    // "Clear site data": the next open sees an empty store and must regenerate.
    const afterClear = await loadOrCreateIdentityKeyPair(memoryStore());
    expect(await pub(afterClear)).not.toBe(await pub(before));
  });
});
