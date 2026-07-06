import { describe, expect, it } from 'vitest';

import { initialSessionState, type SessionStatus } from './session';
import {
  buildSessionRows,
  groupSessions,
  pickDisplayTitle,
  repoTagOf,
  sessionRepoTag,
  sessionCounts,
  type SessionRow,
} from './session-groups';

function row(
  id: string,
  status: SessionStatus,
  createdAt: string,
  lastActivity?: string,
): SessionRow {
  return {
    id,
    title: id,
    status,
    deviceId: 'dev-1',
    deviceName: 'studio-mbp',
    origin: 'launched',
    isContinuation: false,
    parentSessionId: null,
    repo: null,
    cwd: null,
    createdAt: new Date(createdAt),
    lastActivityAt: new Date(lastActivity ?? createdAt),
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
      row('limit', 'turn_limit', '2026-06-29T10:00:00Z'),
      row('restart', 'needs_restart', '2026-06-29T10:00:00Z'),
    ]);
    expect(groups.awaiting.map((r) => r.id)).toEqual(['await']);
    expect(groups.active.map((r) => r.id).sort()).toEqual(['run', 'start']);
    expect(groups.recent.map((r) => r.id).sort()).toEqual([
      'done',
      'err',
      'idle',
      'limit',
      'paused',
      'restart',
    ]);
  });

  it('orders each group newest-first', () => {
    const groups = groupSessions([
      row('old', 'running', '2026-06-29T09:00:00Z'),
      row('new', 'running', '2026-06-29T11:00:00Z'),
      row('mid', 'running', '2026-06-29T10:00:00Z'),
    ]);
    expect(groups.active.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('orders by LAST ACTIVITY, not creation time (ux Phase 6 T7 — a recently-touched old session leads)', () => {
    const groups = groupSessions([
      // Created first but touched last — must lead its group despite the oldest createdAt.
      row('touched', 'done', '2026-06-01T09:00:00Z', '2026-06-29T12:00:00Z'),
      row('fresh', 'done', '2026-06-29T11:00:00Z', '2026-06-29T11:00:00Z'),
      row('stale', 'done', '2026-06-29T10:00:00Z', '2026-06-29T10:30:00Z'),
    ]);
    expect(groups.recent.map((r) => r.id)).toEqual(['touched', 'fresh', 'stale']);
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
  const REG_UPDATED_AT = new Date('2026-07-05T11:00:00Z');
  const registry = [
    {
      id: 's-reg',
      title: 'refactor relay',
      status: 'starting' as const,
      deviceId: 'dev-1',
      origin: 'launched' as const,
      parentSessionId: null,
      createdAt: new Date('2026-07-05T10:00:00Z'),
      updatedAt: REG_UPDATED_AT,
      sealedMeta: null,
      sealedMetaNonce: null,
      sealedTitle: null,
      sealedTitleNonce: null,
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
      // A live-only row has no registry updated_at yet — its activity stamp is the injected clock.
      lastActivityAt: NOW,
    });
  });

  it('maps the registry updated_at to lastActivityAt — the board sorts by real last activity (T7)', () => {
    const rows = buildSessionRows({
      registry,
      live: new Map(),
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows[0]!.lastActivityAt).toEqual(REG_UPDATED_AT);
  });

  it('a live overlay keeps the registry lastActivityAt (frames alone must not resort the board)', () => {
    const live = new Map([['s-reg', { ...initialSessionState, status: 'running' as const }]]);
    const rows = buildSessionRows({
      registry,
      live,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows[0]!.lastActivityAt).toEqual(REG_UPDATED_AT);
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
          updatedAt: new Date('2026-07-01T02:00:00Z'),
          sealedMeta: null,
          sealedMetaNonce: null,
          sealedTitle: null,
          sealedTitleNonce: null,
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
        repo: null,
        cwd: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        lastActivityAt: new Date('2026-07-01T02:00:00Z'),
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

describe('repoTagOf', () => {
  it.each([
    ['/Users/me/Developer/personal/telecode', 'telecode'],
    ['/repos/app/', 'app'], // trailing slash — still the last real segment
    ['relative/path', 'path'],
    ['C:\\Users\\me\\repos\\telecode', 'telecode'], // the browser cannot know which OS made the path
  ])('derives the tag from %s', (cwd, expected) => {
    expect(repoTagOf(cwd)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['/']])('yields no tag for %s', (cwd) => {
    expect(repoTagOf(cwd)).toBeNull();
  });
});

describe('sessionRepoTag', () => {
  it('prefers the meta repo identity over a worktree cwd that ends in the session id', () => {
    expect(
      sessionRepoTag({
        repo: 'me/telecode',
        cwd: '/Users/me/.telecode/worktrees/3f2a0c1e-aaaa-bbbb-cccc-121212121212',
      }),
    ).toBe('telecode');
  });

  it('falls back to the cwd basename when no repo identity was sent (adopted sessions)', () => {
    expect(sessionRepoTag({ repo: null, cwd: '/Users/me/repos/telecode' })).toBe('telecode');
  });

  it('yields no tag when neither is known', () => {
    expect(sessionRepoTag({ repo: null, cwd: null })).toBeNull();
  });
});

describe('buildSessionRows cwd + title sources', () => {
  const NOW = new Date('2026-07-05T12:00:00Z');
  const registry = [
    {
      id: 's-reg',
      title: 'legacy title',
      status: 'running' as const,
      deviceId: 'dev-1',
      origin: 'launched' as const,
      parentSessionId: null,
      createdAt: new Date('2026-07-05T10:00:00Z'),
      updatedAt: new Date('2026-07-05T11:00:00Z'),
      sealedMeta: null,
      sealedMetaNonce: null,
      sealedTitle: null,
      sealedTitleNonce: null,
    },
  ];
  const deviceNameOf = (): string | null => 'macbook';
  const deviceIdOf = (): string | null => 'dev-1';

  it('threads the decrypted metadata cwd onto the registry row (the card repo tag source)', () => {
    const rows = buildSessionRows({
      registry,
      live: new Map(),
      metas: new Map([['s-reg', { cwd: '/Users/me/repos/telecode' }]]),
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows[0]!.cwd).toBe('/Users/me/repos/telecode');
  });

  it('threads the decrypted metadata repo identity onto the row (worktree cwds cannot name it)', () => {
    const rows = buildSessionRows({
      registry,
      live: new Map(),
      metas: new Map([['s-reg', { repo: 'me/telecode', cwd: '/worktrees/s-reg' }]]),
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows[0]!.repo).toBe('me/telecode');
  });

  it('a live overlay without fresh metadata keeps the registry row cwd', () => {
    const live = new Map([['s-reg', { ...initialSessionState, status: 'running' as const }]]);
    const rows = buildSessionRows({
      registry,
      live,
      metas: new Map([['s-reg', { cwd: '/Users/me/repos/telecode' }]]),
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows[0]!.cwd).toBe('/Users/me/repos/telecode');
  });

  it('a persisted injected-machinery meta title falls back to the registry title (display healing)', () => {
    const rows = buildSessionRows({
      registry,
      live: new Map(),
      metas: new Map([
        ['s-reg', { title: '<local-command-caveat>Caveat: generated by the user…' }],
      ]),
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows[0]!.title).toBe('legacy title');
  });

  it('the first-prompt title fallback skips harness-injected machinery entries', () => {
    const live = new Map([
      [
        's-live',
        {
          ...initialSessionState,
          status: 'running' as const,
          entries: [
            {
              kind: 'user' as const,
              id: 'e1',
              text: '<local-command-caveat>Caveat: the messages below were generated…',
            },
            { kind: 'user' as const, id: 'e2', text: 'fix the pairing race' },
          ],
        },
      ],
    ]);
    const rows = buildSessionRows({
      registry: [],
      live,
      deviceNameOf,
      deviceIdOf,
      now: NOW,
    });
    expect(rows[0]!.title).toBe('fix the pairing race');
  });
});

describe('pickDisplayTitle', () => {
  it('returns the first candidate that is real, skipping empty and injected-machinery values', () => {
    expect(
      pickDisplayTitle(
        undefined,
        '',
        '<system-reminder>background task</system-reminder>',
        'fix it',
      ),
    ).toBe('fix it');
  });

  it('returns null when no candidate is real', () => {
    expect(pickDisplayTitle(null, undefined, '<command-name>/clear</command-name>')).toBeNull();
  });
});
