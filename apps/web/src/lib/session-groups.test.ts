import { describe, expect, it } from 'vitest';

import type { SessionStatus } from './session';
import { groupSessions, sessionCounts, type SessionRow } from './session-groups';

function row(id: string, status: SessionStatus, createdAt: string): SessionRow {
  return {
    id,
    title: id,
    status,
    deviceName: 'studio-mbp',
    origin: 'launched',
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
