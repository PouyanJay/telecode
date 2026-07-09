import type { InboxAsk } from './inbox';

/**
 * Dismissed needs-you asks (board-housekeeping): the operator can close an inbox card without
 * answering it — the ask stays PENDING (the agent is still waiting; the session row carries an amber
 * count chip instead), it just stops occupying the inbox. Dismissals are per-ask (`requestId`,
 * unique UUIDs) and remember their SESSION, persisted in `localStorage` so a reload doesn't
 * resurrect closed cards.
 *
 * Pruning is keyed on the LIVE ask list — the only honest "still pending" signal — but only once a
 * session's transcript has actually loaded, so a slow subscribe can't fake a resolve. A dismissal is
 * swept only when its session is loaded (entries backfilled) AND its ask is gone from the live
 * pending list (answered / taken over / the session deleted). While a session is still unloaded it's
 * kept (the reload transient that once wiped dismissals). Status is deliberately NOT the signal: a
 * handover ask can outlive `awaiting_input` — e.g. it rides a session the daemon lost to a restart
 * (`needs_restart`) — and the dismissal must still hold. The persistence is a pure read/write over a
 * `Storage`-shaped seam (the settings.ts pattern) so it unit-tests without a DOM.
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
 * Drop dismissals whose ask has resolved and persist the survivors. A dismissal is kept when its ask
 * is still in the live pending list, OR its session hasn't loaded its transcript yet (we can't know
 * if the ask resolved until we've seen it). It's swept only when the session IS loaded and the ask
 * is gone — the honest "resolved" signal, independent of the session's status.
 */
export function pruneDismissedAsks(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  live: { pendingRequestIds: ReadonlySet<string>; loadedSessionIds: ReadonlySet<string> },
): DismissedAsks {
  const current = readDismissedAsks(storage);
  const next = new Map(
    [...current].filter(
      ([requestId, sessionId]) =>
        live.pendingRequestIds.has(requestId) || !live.loadedSessionIds.has(sessionId),
    ),
  );
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
