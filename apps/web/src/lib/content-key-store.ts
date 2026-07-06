import { openPayload, type CryptoKeyHandle } from '@telecode/protocol';

import { STORES, indexedDbStore } from './indexed-db';

/**
 * Durable per-session content keys (session-identity T3). The browser persists each session's
 * non-extractable AES-GCM content key so a COLD page load can decrypt that session's sealed metadata
 * blob — served over REST by `GET /me/sessions` — with no live daemon and no relay cache. Like the
 * identity keypair, the key survives a reload via IndexedDB structured clone yet stays unreadable to
 * JavaScript. The store, its concrete IndexedDB impl, and {@link openSealedWithStoredKey} are
 * tightly-coupled siblings, co-located here per the one-public-export exception. Wiped on sign-out.
 */
export interface ContentKeyStore {
  get(sessionId: string): Promise<CryptoKeyHandle | undefined>;
  put(sessionId: string, key: CryptoKeyHandle): Promise<void>;
  /** Drop every persisted content key (sign-out). */
  clear(): Promise<void>;
}

/** The production IndexedDB-backed content-key store (browser only). */
export function indexedDbContentKeyStore(): ContentKeyStore {
  return indexedDbStore<CryptoKeyHandle>(STORES.contentKeys);
}

/** The store for the running context: the real IndexedDB one in a browser, `null` under SSR / node. */
export function defaultContentKeyStore(): ContentKeyStore | null {
  return typeof indexedDB !== 'undefined' ? indexedDbContentKeyStore() : null;
}

/**
 * Open a session's sealed blob (payload + nonce) using its persisted content key. Returns the decrypted
 * value, or `null` when no key is stored for the session or the blob can't be opened (tamper / key
 * mismatch) — the caller treats either as "not decryptable on this cold load", never a thrown error.
 */
export async function openSealedWithStoredKey(
  store: ContentKeyStore,
  sessionId: string,
  payload: string,
  nonce: string,
): Promise<unknown> {
  const key = await store.get(sessionId).catch(() => undefined);
  if (key === undefined) return null;
  try {
    return await openPayload({ payload, nonce }, key);
  } catch {
    return null;
  }
}
