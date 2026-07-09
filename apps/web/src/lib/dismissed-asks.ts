import type { InboxAsk } from './inbox';

/**
 * Dismissed needs-you asks (board-housekeeping): the operator can close an inbox card without
 * answering it — the ask stays PENDING (the agent is still waiting; the session row carries an amber
 * count chip instead), it just stops occupying the inbox. Dismissals are per-ask (`requestId`,
 * unique UUIDs) and remember their SESSION, persisted in `localStorage` so a reload doesn't
 * resurrect closed cards.
 *
 * Pruning is deliberately keyed on the SESSION leaving `awaiting_input` — a fact the registry knows
 * instantly on load — never on an ask's absence from the live list: live asks arrive only after the
 * per-session subscribe + backfill, so "not in the list yet" must never read as "resolved" (that
 * exact transient wiped dismissals on reload). An id whose ask resolved while its session stays
 * awaiting (another ask still pending) lingers in storage but is INERT — the visible-card filter
 * and the row chip only ever count ids present in the LIVE ask list — and it's swept when the
 * session finally leaves awaiting. The persistence is a pure read/write over a `Storage`-shaped
 * seam (the settings.ts pattern) so it unit-tests without a DOM.
 */
const STORAGE_KEY = 'telecode:dismissed-asks';

/** requestId → sessionId of every dismissed ask. */
export type DismissedAsks = ReadonlyMap<string, string>;

/** Read the persisted dismissals; unset/corrupt storage reads as none (never throws). */
export function readDismissedAsks(storage: Pick<Storage, 'getItem'>): DismissedAsks {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string',
      ),
    );
  } catch {
    return new Map();
  }
}

function write(storage: Pick<Storage, 'setItem'>, next: DismissedAsks): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
}

/** Dismiss one ask (idempotent) and persist. */
export function dismissAsk(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  requestId: string,
  sessionId: string,
): DismissedAsks {
  const next = new Map(readDismissedAsks(storage));
  next.set(requestId, sessionId);
  write(storage, next);
  return next;
}

/**
 * Drop dismissals whose SESSION is no longer awaiting input (resolved, ended, or deleted) and
 * persist the survivors. `awaitingSessionIds` comes from the board's merged rows — registry-backed,
 * so it is authoritative from the first render and a slow live subscribe can never fake a resolve.
 */
export function pruneDismissedAsks(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  awaitingSessionIds: ReadonlySet<string>,
): DismissedAsks {
  const current = readDismissedAsks(storage);
  const next = new Map([...current].filter(([, sessionId]) => awaitingSessionIds.has(sessionId)));
  if (next.size !== current.size) write(storage, next);
  return next;
}

/** The inbox cards actually shown: pending asks minus the dismissed ones, order preserved. */
export function visibleInboxAsks(asks: readonly InboxAsk[], dismissed: DismissedAsks): InboxAsk[] {
  return asks.filter((ask) => !dismissed.has(ask.requestId));
}

/**
 * How many dismissed-but-still-pending asks each session carries — the row chip's number. Only
 * asks that exist in the live list count (a stale dismissal is inert), so the chip and the inbox
 * can never disagree about what is actually waiting.
 */
export function dismissedAskCountBySession(
  asks: readonly InboxAsk[],
  dismissed: DismissedAsks,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const ask of asks) {
    if (!dismissed.has(ask.requestId)) continue;
    counts.set(ask.sessionId, (counts.get(ask.sessionId) ?? 0) + 1);
  }
  return counts;
}
