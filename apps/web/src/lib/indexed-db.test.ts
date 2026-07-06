import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { indexedDbContentKeyStore } from './content-key-store';
import { indexedDbKeyStore } from './keystore';

/**
 * IndexedDB v1→v2 upgrade (session-identity T3): the DB version bumped from 1 (identity keypair only)
 * to 2 (adds the `content-keys` store). Every existing telecode user's browser hits `onupgradeneeded`
 * on the next page load after this ships — so the identity keypair MUST survive in place, and the new
 * content-keys store must become usable. Driven against a real (faked) IndexedDB, not a mock.
 */
const DB_NAME = 'telecode';

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('delete failed'));
  });
}

/** Create a v1-shaped database (identity store only) with one stored value, as a pre-T3 build left it. */
function seedV1Database(id: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('identity');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('identity', 'readwrite');
      tx.objectStore('identity').put(value, id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('seed write failed'));
    };
    req.onerror = () => reject(req.error ?? new Error('seed open failed'));
  });
}

afterEach(deleteDatabase);

describe('IndexedDB v1 → v2 upgrade', () => {
  it('preserves the existing identity value and makes the new content-keys store usable', async () => {
    // A returning user's browser already holds a v1 database with their identity under 'session-identity'.
    await seedV1Database('session-identity', { marker: 'existing-identity' });

    // Opening through the v2 production stores must upgrade in place — the identity value survives…
    const identity = await indexedDbKeyStore().get('session-identity');
    expect(identity).toEqual({ marker: 'existing-identity' });

    // …and the freshly-created content-keys store round-trips.
    const contentKeys = indexedDbContentKeyStore();
    await contentKeys.put('sess-1', { marker: 'a-content-key' } as never);
    expect(await contentKeys.get('sess-1')).toEqual({ marker: 'a-content-key' });
  });

  it('clear() wipes content keys but leaves the identity store intact', async () => {
    await seedV1Database('session-identity', { marker: 'keep-me' });
    const contentKeys = indexedDbContentKeyStore();
    await contentKeys.put('sess-1', { marker: 'wipe-me' } as never);

    await contentKeys.clear();

    expect(await contentKeys.get('sess-1')).toBeUndefined();
    expect(await indexedDbKeyStore().get('session-identity')).toEqual({ marker: 'keep-me' });
  });
});
