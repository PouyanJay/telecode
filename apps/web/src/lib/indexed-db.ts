/**
 * Shared IndexedDB plumbing for the browser's E2E key stores (Phase 4 identity keypair + ux Phase 6
 * per-session content keys). One database, `telecode`, holds an object store per concern; this module
 * owns the low-level open/transaction boilerplate so each store module (`keystore.ts`,
 * `content-key-store.ts`) only declares its own key/value shape. Values are stored via structured
 * clone, which preserves non-extractable `CryptoKey`s WITHOUT ever exposing their bytes to JavaScript.
 */
const DB_NAME = 'telecode';
// v2 adds the `content-keys` store (ux Phase 6 T3). onupgradeneeded creates any missing store, so a v1
// database (identity keypair only) upgrades in place without losing it.
const DB_VERSION = 2;

/** Every object store the database holds — created together on upgrade (IndexedDB upgrades DB-wide). */
export const STORES = {
  identity: 'identity',
  contentKeys: 'content-keys',
} as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of Object.values(STORES)) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
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

/** Run a readwrite transaction on one store and resolve when it commits (rejects on error/abort). */
async function runReadwrite(
  store: StoreName,
  action: (objectStore: IDBObjectStore) => void,
): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(store, 'readwrite');
    action(tx.objectStore(store));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
  } finally {
    db.close();
  }
}

/** A minimal async key/value store over one IndexedDB object store — the shape both key stores use. */
export interface IndexedDbStore<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  clear(): Promise<void>;
}

/** Build a typed key/value store backed by one IndexedDB object store (the seam tests replace in node). */
export function indexedDbStore<T>(store: StoreName): IndexedDbStore<T> {
  return {
    async get(key): Promise<T | undefined> {
      const db = await openDatabase();
      try {
        const tx = db.transaction(store, 'readonly');
        return (await awaitRequest(tx.objectStore(store).get(key))) as T | undefined;
      } finally {
        db.close();
      }
    },
    put(key, value): Promise<void> {
      return runReadwrite(store, (objectStore) => objectStore.put(value, key));
    },
    clear(): Promise<void> {
      return runReadwrite(store, (objectStore) => objectStore.clear());
    },
  };
}
