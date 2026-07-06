import type { SessionOrigin, SessionStatusName } from '@telecode/protocol';

import type { SessionState, SessionStatus } from './session';

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
  /**
   * True when this session is a forked continuation of another (it has a `parentSessionId` — a free-form
   * handover the user took over, Journey 4). The dashboard marks it so a continuation is distinguishable
   * from a plain launch in the list, not only inside the session view.
   */
  readonly isContinuation: boolean;
  /**
   * The session this one continues, when known — the chain link `buildThreadRows` collapses into one
   * thread row (ux Phase 3). From the registry, or a live `session.chained` frame for a fresh fork.
   */
  readonly parentSessionId: string | null;
  readonly createdAt: Date;
}

/** A persisted-registry session, as the layout load delivers it (the fields the dashboard renders). */
export interface RegistrySessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly status: SessionStatusName;
  readonly deviceId: string;
  readonly origin: SessionOrigin;
  readonly parentSessionId: string | null;
  readonly createdAt: Date;
}

function firstPrompt(entries: SessionState['entries']): string | undefined {
  return entries.find((entry) => entry.kind === 'user')?.text;
}

/**
 * THE single merge of the persisted registry with the live channel — every surface that shows session
 * rows or tallies (dashboard list, system bar, sidebar badge) builds from this one function, so their
 * numbers can never disagree. Registry rows are overlaid with live status; sessions launched this visit
 * but not yet persisted are appended, attributed to the watched device (the only device launches go to).
 */
export function buildSessionRows(input: {
  readonly registry: readonly RegistrySessionRow[];
  readonly live: ReadonlyMap<string, SessionState>;
  readonly deviceNameOf: (deviceId: string) => string | null;
  readonly watchedDeviceName: string | null;
  /** Clock for the createdAt of not-yet-persisted live sessions (injected so the merge stays pure). */
  readonly now?: Date;
}): SessionRow[] {
  const byId = new Map<string, SessionRow>();
  for (const session of input.registry) {
    byId.set(session.id, {
      id: session.id,
      title: session.title,
      status: session.status,
      deviceName: input.deviceNameOf(session.deviceId),
      origin: session.origin,
      isContinuation: session.parentSessionId !== null,
      parentSessionId: session.parentSessionId,
      createdAt: session.createdAt,
    });
  }
  for (const [id, state] of input.live) {
    const existing = byId.get(id);
    // A live state that is still `idle` carries no frames yet — keep what the registry says.
    const status = state.status === 'idle' ? (existing?.status ?? 'starting') : state.status;
    const title = existing?.title ?? firstPrompt(state.entries) ?? null;
    // Continuation link from either source: the persisted registry, or a live `session.chained` frame.
    const parentSessionId = existing?.parentSessionId ?? state.parentSessionId;
    byId.set(id, {
      id,
      title,
      status,
      deviceName: existing?.deviceName ?? input.watchedDeviceName,
      // A session launched this visit is `launched`; an adopted one carries its origin from the registry.
      origin: existing?.origin ?? 'launched',
      isContinuation: parentSessionId !== null,
      parentSessionId,
      createdAt: existing?.createdAt ?? input.now ?? new Date(),
    });
  }
  return [...byId.values()];
}

/** The dashboard's three buckets (the mockup's "Needs your decision" / "Active" / "Recent"). */
export type SessionGroupKey = 'awaiting' | 'active' | 'recent';

/** Generic over the row so a collapsed thread row (ux Phase 3) keeps its type through grouping. */
export interface SessionGroups<Row extends SessionRow = SessionRow> {
  readonly awaiting: readonly Row[];
  readonly active: readonly Row[];
  readonly recent: readonly Row[];
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
export function groupSessions<Row extends SessionRow>(rows: readonly Row[]): SessionGroups<Row> {
  const groups: Record<SessionGroupKey, Row[]> = { awaiting: [], active: [], recent: [] };
  for (const row of rows) groups[groupKey(row.status)].push(row);
  const newestFirst = (a: Row, b: Row): number => b.createdAt.getTime() - a.createdAt.getTime();
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
