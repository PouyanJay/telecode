import { generateIdentityKeyPair, type CryptoKeyPairHandle } from '@telecode/protocol';

/**
 * Persistent storage for the browser's E2E identity keypair (Phase 4 Task 7). The keypair is a
 * **non-extractable** WebCrypto `CryptoKeyPair`: IndexedDB stores it via structured clone WITHOUT ever
 * exposing the private bytes to JavaScript, so the key survives a reload yet stays unreadable — even XSS
 * can use it to decrypt but never exfiltrate it. Reusing one identity across reopens lets a same-device
 * reload decrypt cached history immediately (with the relay's ciphertext cache, Task 8): the daemon/relay
 * re-deliver the same content key wrapped to a stable public key, so no fresh handshake is needed.
 */
const DB_NAME = 'telecode';
const DB_VERSION = 1;
const STORE = 'identity';
const IDENTITY_ID = 'session-identity';

/**
 * A minimal async key/value store for `CryptoKeyPair`s — the seam that keeps the load-or-create logic
 * unit-testable in node (which has no IndexedDB): tests inject an in-memory store; production uses
 * {@link indexedDbKeyStore}.
 */
export interface IdentityKeyStore {
  get(id: string): Promise<CryptoKeyPairHandle | undefined>;
  put(id: string, keyPair: CryptoKeyPairHandle): Promise<void>;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open IndexedDB'));
  });
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** The production IndexedDB-backed identity store (browser only). */
export function indexedDbKeyStore(): IdentityKeyStore {
  return {
    async get(id): Promise<CryptoKeyPairHandle | undefined> {
      const db = await openDatabase();
      try {
        const tx = db.transaction(STORE, 'readonly');
        return (await awaitRequest(tx.objectStore(STORE).get(id))) as
          | CryptoKeyPairHandle
          | undefined;
      } finally {
        db.close();
      }
    },
    async put(id, keyPair): Promise<void> {
      const db = await openDatabase();
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(keyPair, id);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
        });
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Load the persisted browser identity keypair, generating and storing a fresh non-extractable one on
 * first use. Subsequent reopens reuse the same identity, so the browser announces a stable public key and
 * the daemon re-delivers the same content key — letting cached history decrypt without a re-handshake.
 */
export async function loadOrCreateIdentityKeyPair(
  store: IdentityKeyStore = indexedDbKeyStore(),
  generate: () => Promise<CryptoKeyPairHandle> = () => generateIdentityKeyPair(false),
): Promise<CryptoKeyPairHandle> {
  const existing = await store.get(IDENTITY_ID);
  if (existing) return existing;
  const keyPair = await generate();
  await store.put(IDENTITY_ID, keyPair);
  return keyPair;
}
