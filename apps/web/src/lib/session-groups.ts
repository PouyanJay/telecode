import type { SessionOrigin } from '@telecode/protocol';

import type { SessionStatus } from './session';

/**
 * The dashboard presentation layer: how the session list is bucketed, ordered, and tallied. Kept apart
 * from the live frame reducer (`sessions.ts`) so each file owns one concern. Pure and unit-tested.
 *
 * One dashboard row: a persisted-registry session overlaid with live status, plus the watching device's
 * display name for the row meta. Built in the page from `data.sessions` + the live session map.
 */
export interface SessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly status: SessionStatus;
  readonly deviceName: string | null;
  /** `external` rows are adopted from the user's own Claude Code runs; the dashboard marks them. */
  readonly origin: SessionOrigin;
  readonly createdAt: Date;
}

/** The dashboard's three buckets (the mockup's "Needs your decision" / "Active" / "Recent"). */
export type SessionGroupKey = 'awaiting' | 'active' | 'recent';

export interface SessionGroups {
  readonly awaiting: readonly SessionRow[];
  readonly active: readonly SessionRow[];
  readonly recent: readonly SessionRow[];
}

/**
 * Which bucket a status belongs to. Every status is listed explicitly so adding a new one to the protocol
 * is a compile error here (via the `never` check) rather than a silent fall into "recent".
 */
function groupKey(status: SessionStatus): SessionGroupKey {
  switch (status) {
    case 'awaiting_input':
      return 'awaiting';
    case 'running':
    case 'starting':
      return 'active';
    case 'done':
    case 'error':
    case 'offline_paused':
    case 'idle':
      return 'recent';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Partition rows into the dashboard's three groups, newest-first within each. */
export function groupSessions(rows: readonly SessionRow[]): SessionGroups {
  const groups: Record<SessionGroupKey, SessionRow[]> = { awaiting: [], active: [], recent: [] };
  for (const row of rows) groups[groupKey(row.status)].push(row);
  const newestFirst = (a: SessionRow, b: SessionRow): number =>
    b.createdAt.getTime() - a.createdAt.getTime();
  return {
    awaiting: groups.awaiting.sort(newestFirst),
    active: groups.active.sort(newestFirst),
    recent: groups.recent.sort(newestFirst),
  };
}

/** Live tallies for the system bar / dashboard header: agents doing work, and those blocked on you. */
export interface SessionCounts {
  /** Sessions actively working (running or starting). */
  readonly running: number;
  /** Sessions blocked awaiting a human decision — the loud signal. */
  readonly awaiting: number;
}

export function sessionCounts(rows: readonly Pick<SessionRow, 'status'>[]): SessionCounts {
  let running = 0;
  let awaiting = 0;
  for (const row of rows) {
    if (row.status === 'awaiting_input') awaiting += 1;
    else if (row.status === 'running' || row.status === 'starting') running += 1;
  }
  return { running, awaiting };
}
