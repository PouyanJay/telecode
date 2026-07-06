import { makeEnvelope } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { applyMetaFrame, seedRegistryMetas, type SessionMetaMap } from './session-meta';
import { buildSessionRows, type RegistrySessionRow } from './session-groups';
import { initialSessionState, type SessionState } from './session';

/**
 * Sealed session metadata, web leg (session-identity T1). Live `session.meta` frames (decrypted upstream
 * by the relay client) and cleartext registry blobs both land in one meta map; the dashboard merge
 * prefers a meta title over the registry's legacy cleartext title over the first-prompt fallback.
 */
const EMPTY: SessionMetaMap = new Map();

function metaEnvelope(sessionId: string, payload: unknown) {
  return makeEnvelope({
    type: 'session.meta',
    userId: 'u1',
    deviceId: 'd1',
    sessionId,
    payload,
  });
}

describe('applyMetaFrame', () => {
  it('records a valid session.meta payload', () => {
    const map = applyMetaFrame(EMPTY, metaEnvelope('s1', { title: 'fix auth', cwd: '/repo' }));
    expect(map.get('s1')).toMatchObject({ title: 'fix auth', cwd: '/repo' });
  });

  it('merges partial updates instead of replacing (a later model-only frame keeps the title)', () => {
    let map = applyMetaFrame(EMPTY, metaEnvelope('s1', { title: 'fix auth' }));
    map = applyMetaFrame(map, metaEnvelope('s1', { model: 'claude-sonnet-5' }));
    expect(map.get('s1')).toMatchObject({ title: 'fix auth', model: 'claude-sonnet-5' });
  });

  it('ignores a frame without a session id', () => {
    const noSession = makeEnvelope({
      type: 'session.meta',
      userId: 'u1',
      deviceId: 'd1',
      payload: { title: 'x' },
    });
    expect(applyMetaFrame(EMPTY, noSession)).toBe(EMPTY);
  });

  it('never parses undecrypted ciphertext (a frame this browser held no key for)', () => {
    const ciphertext = makeEnvelope({
      type: 'session.meta',
      userId: 'u1',
      deviceId: 'd1',
      sessionId: 's1',
      payload: 'AAAA...ciphertext',
      nonce: 'AAAAAAAAAAAAAAAA',
    });
    expect(applyMetaFrame(EMPTY, ciphertext)).toBe(EMPTY);
  });

  it('ignores a schema-invalid payload', () => {
    expect(applyMetaFrame(EMPTY, metaEnvelope('s1', { title: 42 }))).toBe(EMPTY);
  });
});

describe('seedRegistryMetas', () => {
  const row = (over: Partial<RegistrySessionRow> & { id: string }): RegistrySessionRow => ({
    title: null,
    status: 'done',
    deviceId: 'd1',
    origin: 'launched',
    parentSessionId: null,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    sealedMeta: null,
    sealedMetaNonce: null,
    ...over,
  });

  it('decodes cleartext blobs (empty nonce) from the registry', () => {
    const map = seedRegistryMetas(EMPTY, [
      row({ id: 's1', sealedMeta: JSON.stringify({ title: 'adopted run' }), sealedMetaNonce: '' }),
    ]);
    expect(map.get('s1')).toMatchObject({ title: 'adopted run' });
  });

  it('never overwrites live meta and skips ciphertext or malformed blobs', () => {
    const live = applyMetaFrame(EMPTY, metaEnvelope('s1', { title: 'live title' }));
    const map = seedRegistryMetas(live, [
      row({ id: 's1', sealedMeta: JSON.stringify({ title: 'stale' }), sealedMetaNonce: '' }),
      // Ciphertext (non-empty nonce) is undecryptable without the session key — skipped in T1.
      row({ id: 's2', sealedMeta: 'AAAA', sealedMetaNonce: 'AAAAAAAAAAAAAAAA' }),
      row({ id: 's3', sealedMeta: 'not json', sealedMetaNonce: '' }),
      row({ id: 's4', sealedMeta: null, sealedMetaNonce: null }),
    ]);
    expect(map.get('s1')).toMatchObject({ title: 'live title' });
    expect(map.has('s2')).toBe(false);
    expect(map.has('s3')).toBe(false);
    expect(map.has('s4')).toBe(false);
  });
});

describe('buildSessionRows title precedence with metas', () => {
  const registryRow: RegistrySessionRow = {
    id: 's1',
    title: 'legacy cleartext title',
    status: 'running',
    deviceId: 'd1',
    origin: 'launched',
    parentSessionId: null,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    sealedMeta: null,
    sealedMetaNonce: null,
  };
  const liveState: SessionState = {
    ...initialSessionState,
    sessionId: 's1',
    status: 'running',
    entries: [{ kind: 'user', id: 'e0', text: 'the first prompt' }],
  };

  const noDevice = (): null => null;

  it('prefers the decrypted meta title over the registry title and the first prompt', () => {
    const metas = applyMetaFrame(EMPTY, metaEnvelope('s1', { title: 'meta title' }));
    const rows = buildSessionRows({
      registry: [registryRow],
      live: new Map([['s1', liveState]]),
      metas,
      deviceNameOf: noDevice,
      deviceIdOf: noDevice,
    });
    expect(rows[0]?.title).toBe('meta title');
  });

  it('falls back to the registry title, then the first prompt, when no meta exists', () => {
    const withRegistry = buildSessionRows({
      registry: [registryRow],
      live: new Map(),
      metas: EMPTY,
      deviceNameOf: noDevice,
      deviceIdOf: noDevice,
    });
    expect(withRegistry[0]?.title).toBe('legacy cleartext title');

    const liveOnly = buildSessionRows({
      registry: [],
      live: new Map([['s1', liveState]]),
      metas: EMPTY,
      deviceNameOf: noDevice,
      deviceIdOf: noDevice,
    });
    expect(liveOnly[0]?.title).toBe('the first prompt');
  });
});
