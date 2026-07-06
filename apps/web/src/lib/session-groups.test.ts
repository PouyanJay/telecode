import { describe, expect, it } from 'vitest';

import { initialSessionState, type SessionStatus } from './session';
import { buildSessionRows, groupSessions, sessionCounts, type SessionRow } from './session-groups';

function row(id: string, status: SessionStatus, createdAt: string): SessionRow {
  return {
    id,
    title: id,
    status,
    deviceId: 'dev-1',
    deviceName: 'studio-mbp',
    origin: 'launched',
    isContinuation: false,
    parentSessionId: null,
    createdAt: new Date(createdAt),
  };
}

describe('groupSessions', () => {
  it('partitions rows into awaiting / active / recent by status', () => {
    const groups = groupSessions([
      row('done', 'done', '2026-06-29T10:00:00Z'),
      row('await', 'awaiting_input', '2026-06-29T10:00:00Z'),
      row('run', 'running', '2026-06-29T10:00:00Z'),
      row('start', 'starting', '2026-06-29T10:00:00Z'),
      row('err', 'error', '2026-06-29T10:00:00Z'),
      row('paused', 'offline_paused', '2026-06-29T10:00:00Z'),
      row('idle', 'idle', '2026-06-29T10:00:00Z'),
    ]);
    expect(groups.awaiting.map((r) => r.id)).toEqual(['await']);
    expect(groups.active.map((r) => r.id).sort()).toEqual(['run', 'start']);
    expect(groups.recent.map((r) => r.id).sort()).toEqual(['done', 'err', 'idle', 'paused']);
  });

  it('orders each group newest-first', () => {
    const groups = groupSessions([
      row('old', 'running', '2026-06-29T09:00:00Z'),
      row('new', 'running', '2026-06-29T11:00:00Z'),
      row('mid', 'running', '2026-06-29T10:00:00Z'),
    ]);
    expect(groups.active.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('returns empty buckets rather than omitting them', () => {
    expect(groupSessions([])).toEqual({ awaiting: [], active: [], recent: [] });
  });

  it('buckets by status regardless of isContinuation (a display flag, never a grouping criterion)', () => {
    const groups = groupSessions([
      { ...row('cont', 'running', '2026-06-29T10:00:00Z'), isContinuation: true },
    ]);
    expect(groups.active.map((r) => r.id)).toEqual(['cont']);
  });
});

describe('sessionCounts', () => {
  it('tallies running (incl. starting) and awaiting, ignoring terminal/idle', () => {
    const counts = sessionCounts([
      row('a', 'awaiting_input', '2026-06-29T10:00:00Z'),
      row('b', 'running', '2026-06-29T10:00:00Z'),
      row('c', 'starting', '2026-06-29T10:00:00Z'),
      row('d', 'done', '2026-06-29T10:00:00Z'),
      row('e', 'idle', '2026-06-29T10:00:00Z'),
    ]);
    expect(counts).toEqual({ running: 2, awaiting: 1 });
  });

  it('does not count error or offline_paused sessions as running or awaiting', () => {
    const counts = sessionCounts([
      row('a', 'error', '2026-06-29T10:00:00Z'),
      row('b', 'offline_paused', '2026-06-29T10:00:00Z'),
    ]);
    expect(counts).toEqual({ running: 0, awaiting: 0 });
  });
});

describe('buildSessionRows', () => {
  const NOW = new Date('2026-07-05T12:00:00Z');
  const registry = [
    {
      id: 's-reg',
      title: 'refactor relay',
      status: 'starting' as const,
      deviceId: 'dev-1',
      origin: 'launched' as const,
      parentSessionId: null,
      createdAt: new Date('2026-07-05T10:00:00Z'),
      sealedMeta: null,
      sealedMetaNonce: null,
    },
  ];
  const deviceNameOf = (deviceId: string): string | null =>
    deviceId === 'dev-1' ? 'macbook' : null;
  // The live routing map: a session launched this visit arrived on dev-1's channel.
  const deviceIdOf = (sessionId: string): string | null =>
    sessionId === 's-live' ? 'dev-1' : null;

  it('overlays live status onto the persisted registry row', () => {
    const live = new Map([['s-reg', { ...initialSessionState, status: 'running' as const }]]);
    const rows = buildSessionRows({
      registry,
      live,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 's-reg', status: 'running', deviceName: 'macbook' });
  });

  it('keeps the registry status when the live state is idle (no frames yet)', () => {
    const live = new Map([['s-reg', { ...initialSessionState }]]);
    const rows = buildSessionRows({
      registry,
      live,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows[0]).toMatchObject({ id: 's-reg', status: 'starting', title: 'refactor relay' });
  });

  it('appends a live-only session (launched this visit) attributed to the watched device', () => {
    const live = new Map([
      [
        's-live',
        {
          ...initialSessionState,
          status: 'running' as const,
          entries: [{ kind: 'user' as const, id: 'e1', text: 'fix the pairing race' }],
        },
      ],
    ]);
    const rows = buildSessionRows({
      registry,
      live,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    const liveRow = rows.find((r) => r.id === 's-live');
    expect(liveRow).toMatchObject({
      status: 'running',
      title: 'fix the pairing race',
      deviceName: 'macbook',
      origin: 'launched',
      isContinuation: false,
      createdAt: NOW,
    });
  });

  it('marks a continuation from either the registry link or a live session.chained frame', () => {
    const chainedRegistry = [{ ...registry[0]!, id: 's-child', parentSessionId: 's-parent' }];
    const liveChained = new Map([
      [
        's-live-child',
        { ...initialSessionState, status: 'running' as const, parentSessionId: 'p' },
      ],
    ]);
    const rows = buildSessionRows({
      registry: chainedRegistry,
      live: liveChained,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows.find((r) => r.id === 's-child')?.isContinuation).toBe(true);
    expect(rows.find((r) => r.id === 's-live-child')?.isContinuation).toBe(true);
  });

  it('marks a continuation when a live session.chained frame arrives for an EXISTING registry row', () => {
    // The overlay OR: the registry row predates the chain link (parentSessionId null), the live frame
    // carries it — the merged row must read as a continuation.
    const liveChained = new Map([
      ['s-reg', { ...initialSessionState, status: 'running' as const, parentSessionId: 'p' }],
    ]);
    const rows = buildSessionRows({
      registry,
      live: liveChained,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows.find((r) => r.id === 's-reg')?.isContinuation).toBe(true);
  });

  it('leaves a live-only session with no entries untitled (null, no throw)', () => {
    const live = new Map([['s-empty', { ...initialSessionState, status: 'running' as const }]]);
    const rows = buildSessionRows({
      registry: [],
      live,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBeNull();
  });

  it('feeds sessionCounts so every surface reports the same awaiting/running numbers', () => {
    const live = new Map([
      ['s-reg', { ...initialSessionState, status: 'awaiting_input' as const }],
      ['s-live', { ...initialSessionState, status: 'running' as const }],
    ]);
    const rows = buildSessionRows({
      registry,
      live,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(sessionCounts(rows)).toEqual({ running: 1, awaiting: 1 });
  });
});

describe('buildSessionRows variants', () => {
  const deviceIdOf = (): string | null => null;

  it('passes registry rows through untouched when nothing is live', () => {
    const rows = buildSessionRows({
      registry: [
        {
          id: 's-done',
          title: 'shipped',
          status: 'done',
          deviceId: 'dev-1',
          origin: 'external',
          parentSessionId: null,
          createdAt: new Date('2026-07-01T00:00:00Z'),
          sealedMeta: null,
          sealedMetaNonce: null,
        },
      ],
      live: new Map(),
      deviceNameOf: () => 'macbook',
      deviceIdOf,
    });
    expect(rows).toEqual([
      {
        id: 's-done',
        title: 'shipped',
        status: 'done',
        deviceId: 'dev-1',
        deviceName: 'macbook',
        origin: 'external',
        isContinuation: false,
        parentSessionId: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
    ]);
  });

  it('returns no rows when both sources are empty', () => {
    const rows = buildSessionRows({
      registry: [],
      live: new Map(),
      deviceNameOf: () => null,
      deviceIdOf,
    });
    expect(rows).toEqual([]);
  });
});
