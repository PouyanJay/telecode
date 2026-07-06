import { makeEnvelope } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import {
  applyTitleFrame,
  overlayMissingTitles,
  seedRegistryTitles,
  seedRegistryTitlesAsync,
  type SessionTitleMap,
} from './session-title';
import { buildRegistryRow as buildRow } from './test-support/registry-row';

/**
 * Session-title override, web leg (ux Phase 6 T6). Live `session.title` frames (decrypted upstream by the
 * relay client) and cleartext/ciphertext registry blobs land in one override map, kept SEPARATE from the
 * meta map so the override always wins on display and a later derived title can't clobber a rename.
 */
const EMPTY: SessionTitleMap = new Map();

/** A decrypted `session.title` frame: the relay client swaps in the plaintext payload, keeping the nonce. */
function titleFrame(sessionId: string, payload: unknown, nonce = '') {
  return makeEnvelope({
    type: 'session.title',
    userId: 'u1',
    deviceId: 'd1',
    sessionId,
    payload,
    nonce,
  });
}

describe('applyTitleFrame', () => {
  it('sets the override from a decrypted SET frame', () => {
    const map = applyTitleFrame(EMPTY, titleFrame('s1', { title: 'My deploy' }, 'nonce'));
    expect(map.get('s1')).toBe('My deploy');
  });

  it('clears the override on a RESET frame', () => {
    const set = applyTitleFrame(EMPTY, titleFrame('s1', { title: 'My deploy' }, 'nonce'));
    const reset = applyTitleFrame(set, titleFrame('s1', { reset: true }));
    expect(reset.has('s1')).toBe(false);
  });

  it('ignores undecryptable ciphertext (a raw string blob with a nonce) — never stores it as a title', () => {
    const map = applyTitleFrame(EMPTY, titleFrame('s1', 'b2FxdWU=', 'nonce'));
    expect(map.has('s1')).toBe(false);
  });

  it('ignores an invalid payload (empty or unknown-shape)', () => {
    expect(applyTitleFrame(EMPTY, titleFrame('s1', { title: '' }, 'nonce')).has('s1')).toBe(false);
    expect(applyTitleFrame(EMPTY, titleFrame('s1', { nope: 1 }, 'nonce')).has('s1')).toBe(false);
  });

  it('ignores a frame carrying no session id', () => {
    const noId = makeEnvelope({
      type: 'session.title',
      userId: 'u1',
      deviceId: 'd1',
      payload: { title: 'orphan' },
    });
    expect(applyTitleFrame(EMPTY, noId).size).toBe(0);
  });
});

describe('seedRegistryTitles (cleartext cold load)', () => {
  it('decodes a cleartext sealed_title blob into the override', () => {
    const rows = [
      buildRow({
        id: 's1',
        sealedTitle: JSON.stringify({ title: 'renamed' }),
        sealedTitleNonce: '',
      }),
    ];
    expect(seedRegistryTitles(EMPTY, rows).get('s1')).toBe('renamed');
  });

  it('skips ciphertext blobs (non-empty nonce) and rows without an override', () => {
    const rows = [
      buildRow({ id: 's1', sealedTitle: 'Y2lwaGVy', sealedTitleNonce: 'nonce' }),
      buildRow({ id: 's2', sealedTitle: null, sealedTitleNonce: null }),
    ];
    const map = seedRegistryTitles(EMPTY, rows);
    expect(map.has('s1')).toBe(false);
    expect(map.has('s2')).toBe(false);
  });

  it('never overwrites a live override already in the map', () => {
    const live = new Map([['s1', 'live rename']]);
    const rows = [
      buildRow({ id: 's1', sealedTitle: JSON.stringify({ title: 'stale' }), sealedTitleNonce: '' }),
    ];
    expect(seedRegistryTitles(live, rows).get('s1')).toBe('live rename');
  });
});

describe('seedRegistryTitlesAsync (ciphertext cold load, T6 durability)', () => {
  it('decrypts a ciphertext sealed_title with the persisted key', async () => {
    const rows = [buildRow({ id: 's1', sealedTitle: 'Y2lwaGVy', sealedTitleNonce: 'nonce' })];
    const decrypt = async () => ({ title: 'decrypted rename' });
    const map = await seedRegistryTitlesAsync(EMPTY, rows, decrypt);
    expect(map.get('s1')).toBe('decrypted rename');
  });

  it('skips a blob this browser holds no key for', async () => {
    const rows = [buildRow({ id: 's1', sealedTitle: 'Y2lwaGVy', sealedTitleNonce: 'nonce' })];
    const map = await seedRegistryTitlesAsync(EMPTY, rows, async () => null);
    expect(map.has('s1')).toBe(false);
  });
});

describe('overlayMissingTitles', () => {
  it('adds only the ids the live map lacks (a live frame wins)', () => {
    const live = new Map([['s1', 'live']]);
    const decrypted = new Map([
      ['s1', 'stale'],
      ['s2', 'cold'],
    ]);
    const merged = overlayMissingTitles(live, decrypted);
    expect(merged.get('s1')).toBe('live');
    expect(merged.get('s2')).toBe('cold');
  });
});
