import { describe, expect, it } from 'vitest';

import { decodeSessionCursor, encodeSessionCursor } from '../src/registry/session-cursor';

/**
 * The pagination cursor codec (ux Phase 6 T7) — the one boundary where an opaque client-echoed string
 * becomes query inputs, so every malformed shape must decode to null (the route then 400s).
 */
const CURSOR = {
  updatedAt: new Date('2026-07-02T10:00:00.000Z'),
  id: '3b1f8a52-9f0e-4a4f-9a2f-1c2d3e4f5a6b',
};

describe('session cursor codec', () => {
  it('round-trips a cursor with its view scope', () => {
    const wire = encodeSessionCursor(CURSOR, 'ended');
    expect(decodeSessionCursor(wire)).toEqual({ cursor: CURSOR, scope: 'ended' });
    const archivedWire = encodeSessionCursor(CURSOR, 'archived');
    expect(decodeSessionCursor(archivedWire)?.scope).toBe('archived');
  });

  it('rejects garbage: not base64 JSON, wrong shape, bad uuid, bad datetime, bad scope', () => {
    expect(decodeSessionCursor('not-a-cursor')).toBeNull();
    expect(decodeSessionCursor(Buffer.from('"just a string"').toString('base64url'))).toBeNull();
    const encode = (payload: unknown): string =>
      Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(decodeSessionCursor(encode({ u: CURSOR.updatedAt.toISOString() }))).toBeNull();
    expect(
      decodeSessionCursor(
        encode({ u: CURSOR.updatedAt.toISOString(), id: 'not-a-uuid', s: 'ended' }),
      ),
    ).toBeNull();
    expect(decodeSessionCursor(encode({ u: 'yesterday', id: CURSOR.id, s: 'ended' }))).toBeNull();
    expect(
      decodeSessionCursor(encode({ u: CURSOR.updatedAt.toISOString(), id: CURSOR.id, s: 'all' })),
    ).toBeNull();
  });
});
