import {
  exportContentKey,
  generateContentKey,
  importContentKey,
  sealPayload,
  type CryptoKeyHandle,
} from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { openSealedWithStoredKey, type ContentKeyStore } from './content-key-store';

/**
 * Content-key durability, browser leg (session-identity T3): the per-session AES-GCM content keys are
 * persisted (non-extractable) so a COLD page load can decrypt a session's sealed metadata blob — read
 * from `GET /me/sessions` over REST — with NO live daemon and NO relay cache. The store is the seam
 * (IndexedDB in production, an in-memory map in tests).
 */
function memoryStore(): ContentKeyStore {
  const map = new Map<string, CryptoKeyHandle>();
  return {
    get: (id) => Promise.resolve(map.get(id)),
    put: (id, key) => {
      map.set(id, key);
      return Promise.resolve();
    },
    clear: () => {
      map.clear();
      return Promise.resolve();
    },
  };
}

/** Seed the store with a non-extractable copy of a content key, as the cipher does on `receiveKey`. */
async function seed(
  store: ContentKeyStore,
  sessionId: string,
  key: CryptoKeyHandle,
): Promise<void> {
  await store.put(sessionId, await importContentKey(await exportContentKey(key), false));
}

describe('openSealedWithStoredKey', () => {
  it('decrypts a sealed blob using the session’s persisted content key', async () => {
    const store = memoryStore();
    const key = await generateContentKey(true);
    await seed(store, 'sess-1', key);

    const sealed = await sealPayload({ title: 'cold-load title' }, key);
    const opened = await openSealedWithStoredKey(store, 'sess-1', sealed.payload, sealed.nonce);
    expect(opened).toEqual({ title: 'cold-load title' });
  });

  it('returns null when no key is persisted for the session', async () => {
    const store = memoryStore();
    const key = await generateContentKey(true);
    const sealed = await sealPayload({ title: 'x' }, key);
    expect(
      await openSealedWithStoredKey(store, 'unknown', sealed.payload, sealed.nonce),
    ).toBeNull();
  });

  it('returns null on a tampered/mismatched blob rather than throwing', async () => {
    const store = memoryStore();
    const key = await generateContentKey(true);
    await seed(store, 'sess-1', key);
    const sealed = await sealPayload({ title: 'x' }, key);
    const tampered = `${sealed.payload[0] === 'A' ? 'B' : 'A'}${sealed.payload.slice(1)}`;
    expect(await openSealedWithStoredKey(store, 'sess-1', tampered, sealed.nonce)).toBeNull();
  });
});
