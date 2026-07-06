import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendSessionRows, fetchSessionPage } from './housekeeping';
import { buildRegistryRow } from './test-support/registry-row';

/**
 * Housekeeping client helpers (ux Phase 6 T7): `fetchSessionPage` pulls one more page of ended (or
 * archived) sessions from the BFF and revives it into registry-row shape; `appendSessionRows` merges a
 * fetched page under the already-loaded rows without ever duplicating an id. Pure logic + a fetch stub —
 * the reactive pages consume these.
 */

function stubFetch(impl: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

const wireRow = (id: string, updatedAt = '2026-07-02T10:00:00.000Z'): Record<string, unknown> => ({
  id,
  deviceId: 'd1',
  title: null,
  status: 'done',
  origin: 'launched',
  parentSessionId: null,
  sealedMeta: null,
  sealedMetaNonce: null,
  sealedTitle: null,
  sealedTitleNonce: null,
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt,
  endedAt: updatedAt,
  archivedAt: null,
});

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSessionPage', () => {
  it('GETs the BFF with the cursor and revives rows (dates) + the next cursor', async () => {
    const mock = stubFetch(() =>
      Promise.resolve(okJson({ sessions: [wireRow('s1')], nextCursor: 'CURSOR-2' })),
    );
    const page = await fetchSessionPage({ cursor: 'CURSOR-1' });
    expect(String(mock.mock.calls[0]![0])).toContain('/api/sessions?');
    expect(String(mock.mock.calls[0]![0])).toContain('cursor=CURSOR-1');
    expect(page).not.toBeNull();
    expect(page!.nextCursor).toBe('CURSOR-2');
    expect(page!.rows[0]).toMatchObject({ id: 's1', status: 'done' });
    expect(page!.rows[0]!.updatedAt).toEqual(new Date('2026-07-02T10:00:00.000Z'));
  });

  it('asks for the archived view when requested', async () => {
    const mock = stubFetch(() => Promise.resolve(okJson({ sessions: [], nextCursor: null })));
    await fetchSessionPage({ cursor: 'C', archived: true });
    expect(String(mock.mock.calls[0]![0])).toContain('archived=true');
  });

  it('returns null on an error status, a malformed body, or an unreachable BFF', async () => {
    stubFetch(() => Promise.resolve(new Response('nope', { status: 502 })));
    expect(await fetchSessionPage({ cursor: 'C' })).toBeNull();

    stubFetch(() => Promise.resolve(okJson({ unexpected: true })));
    expect(await fetchSessionPage({ cursor: 'C' })).toBeNull();

    stubFetch(() => Promise.reject(new Error('offline')));
    expect(await fetchSessionPage({ cursor: 'C' })).toBeNull();
  });
});

describe('appendSessionRows', () => {
  it('appends new rows below the existing ones', () => {
    const existing = [buildRegistryRow({ id: 'a' })];
    const merged = appendSessionRows(existing, [buildRegistryRow({ id: 'b' })]);
    expect(merged.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('never duplicates an id (an already-loaded row wins over a re-fetched copy)', () => {
    const existing = [buildRegistryRow({ id: 'a', title: 'loaded first' })];
    const merged = appendSessionRows(existing, [
      buildRegistryRow({ id: 'a', title: 'stale copy' }),
      buildRegistryRow({ id: 'b' }),
    ]);
    expect(merged.map((r) => r.id)).toEqual(['a', 'b']);
    expect(merged[0]!.title).toBe('loaded first');
  });
});

describe('page-helper variants (T9)', () => {
  it('rejects a row with an unknown status (closed enum at the BFF boundary)', async () => {
    stubFetch(() =>
      Promise.resolve(
        okJson({ sessions: [{ ...wireRow('s1'), status: 'exploded' }], nextCursor: null }),
      ),
    );
    expect(await fetchSessionPage({ cursor: 'C' })).toBeNull();
  });

  it('an empty page with a null cursor is valid (the list simply drained)', async () => {
    stubFetch(() => Promise.resolve(okJson({ sessions: [], nextCursor: null })));
    expect(await fetchSessionPage({ cursor: 'C' })).toEqual({ rows: [], nextCursor: null });
  });

  it('appendSessionRows tolerates empty inputs on either side', () => {
    const row = buildRegistryRow({ id: 'only' });
    expect(appendSessionRows([], [row])).toEqual([row]);
    expect(appendSessionRows([row], [])).toEqual([row]);
    expect(appendSessionRows([], [])).toEqual([]);
  });
});
