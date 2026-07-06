import {
  SESSION_END_STATUSES,
  type SessionEndedPayload,
  type SessionOrigin,
  type SessionStatusName,
} from '@telecode/protocol';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';

import { type Database, type DbHandle } from '../db/client';
import { sessions } from '../db/schema';
import { withUserContext } from '../db/user-context';

/**
 * A user's session as the relay can see it — routing metadata only (never the opaque launch payload).
 * Powers the dashboard list and reconnect; the daemon backfills the actual transcript on subscribe.
 */
export interface SessionSummary {
  readonly id: string;
  readonly deviceId: string;
  readonly title: string | null;
  readonly status: SessionStatusName;
  /** `launched` (started from telecode) or `external` (a user's own Claude Code session telecode adopted). */
  readonly origin: SessionOrigin;
  /**
   * The adopted session this one continues (free-form handover, Journey 4), or `null` for an unchained
   * session. Set on a forked continuation so the dashboard can link parent ↔ child.
   */
  readonly parentSessionId: string | null;
  /**
   * The latest sealed `session.meta` blob (ux Phase 6) — ciphertext the relay stores but can never read
   * (invariant #5). Browsers holding the session key decrypt it client-side for titles on cold loads.
   * `sealedMetaNonce` is `''` for a cleartext-mode (pre-E2E) daemon's plain-JSON blob.
   */
  readonly sealedMeta: string | null;
  readonly sealedMetaNonce: string | null;
  /**
   * The user's sealed rename override (ux Phase 6 T6), separate from `sealedMeta` so a later derived title
   * never clobbers it — the browser merges override-wins. Both `null` until a rename (and after a reset).
   * Ciphertext the relay stores but can never read (invariant #5).
   */
  readonly sealedTitle: string | null;
  readonly sealedTitleNonce: string | null;
  /** When the user shelved this terminal session (ux Phase 6 T7); null = not archived. */
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly endedAt: Date | null;
}

/**
 * One page of the paged session list (ux Phase 6 T7): ACTIVE sessions always in full (live counts must
 * never be short), ENDED ones behind a keyset cursor. `nextCursor` names the last ended row served —
 * null once the list is drained. `(updatedAt, id)` because `updated_at` alone isn't unique.
 */
export interface SessionPageCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

export interface SessionPage {
  readonly sessions: SessionSummary[];
  readonly nextCursor: SessionPageCursor | null;
}

/**
 * The outcome of a housekeeping mutation (archive/unarchive/delete, ux Phase 6 T7): `not_ended`
 * distinguishes "still going — refuse" (a 409 for the route) from "not yours / gone" (`not_found`, 404).
 */
export type SessionMutationOutcome = 'ok' | 'not_found' | 'not_ended';

/**
 * The relay's view of the session registry: it persists only routing metadata it can see on the
 * envelope (`user_id`, `device_id`, generated `session_id`, `status`) — never the launch payload, which
 * is opaque to the relay and encrypted in Phase 3. All writes go through {@link withUserContext} so RLS
 * scopes them to the owning user.
 */
export interface SessionRegistry {
  /**
   * Insert a new session for the user/device and return its generated id. A `launched` session (default)
   * starts at `starting`; an adopted `external` one starts at `running` (it is already underway on the
   * user's machine). `title`/`cwd` seed the row for adopted sessions (a launch fills them in later).
   */
  createSession(input: {
    userId: string;
    deviceId: string;
    origin?: SessionOrigin;
    title?: string;
    cwd?: string;
    /** Link to the adopted session this one continues (free-form handover, Journey 4). */
    parentSessionId?: string;
  }): Promise<string>;
  /**
   * List EVERY session of the user (RLS-scoped), ordered by last activity (`updated_at` desc, id desc
   * tiebreak), archived included. The internal full-list read — reconcile and other relay-side sweeps
   * need totality; the HTTP route serves {@link SessionRegistry.listPage} instead.
   */
  listByUser(userId: string): Promise<SessionSummary[]>;
  /**
   * The dashboard's paged read (ux Phase 6 T7). Default view (`archived: false`): all ACTIVE sessions +
   * one `endedLimit`-sized page of ended, un-archived ones. Archived view: pages of archived sessions
   * only (they are all terminal). A `cursor` names where the previous ended/archived page stopped — a
   * cursor'd call returns ONLY the next page (the caller already holds the active rows). RLS-scoped.
   */
  listPage(input: {
    userId: string;
    endedLimit: number;
    cursor?: SessionPageCursor;
    archived?: boolean;
  }): Promise<SessionPage>;
  /** Flip a session to `running` once the daemon reports it started. No-op if the row isn't the user's. */
  markRunning(input: { userId: string; sessionId: string }): Promise<void>;
  /** Flip a session to `awaiting_input` while a tool request blocks on a human decision. No-op if not the user's. */
  markAwaitingInput(input: { userId: string; sessionId: string }): Promise<void>;
  /**
   * Store the latest sealed `session.meta` blob for a session (ux Phase 6) — latest-wins, opaque to the
   * relay. Bumps `updatedAt` (a metadata change is session activity). No-op if the row isn't the user's.
   */
  setSealedMeta(input: {
    userId: string;
    sessionId: string;
    sealedMeta: string;
    sealedMetaNonce: string;
  }): Promise<void>;
  /**
   * Set (or clear) a session's sealed rename override (ux Phase 6 T6). A rename passes the sealed blob +
   * nonce; a reset-to-derived passes both `null`. Bumps `updatedAt` (a rename is session activity).
   * Returns the session's `deviceId` so the caller can broadcast the change on that device's channel, or
   * `null` when no row is the user's (a 404 for the route). RLS-scoped.
   */
  setSealedTitle(input: {
    userId: string;
    sessionId: string;
    sealedTitle: string | null;
    sealedTitleNonce: string | null;
  }): Promise<{ deviceId: string } | null>;
  /**
   * Shelve (or restore) a TERMINAL session (ux Phase 6 T7). Archive is reversible housekeeping — it must
   * never bump `updated_at` (AD-15: shelving isn't activity; unarchive restores the row at its true
   * recency). Refuses a session that is still going (`not_ended`).
   */
  setArchived(input: {
    userId: string;
    sessionId: string;
    archived: boolean;
  }): Promise<SessionMutationOutcome>;
  /**
   * Permanently delete a TERMINAL session's row (ux Phase 6 T7). The caller evicts the relay's
   * ciphertext replay cache for the id on `ok`. A continuation keeps its row — the parent link nulls
   * (FK `set null`), it is never cascade-deleted. Refuses a session that is still going (`not_ended`).
   */
  deleteSession(input: { userId: string; sessionId: string }): Promise<SessionMutationOutcome>;
  /** Mark a session terminal (any ended state, ux Phase 6 split) with an end timestamp. No-op if not the user's. */
  markEnded(input: {
    userId: string;
    sessionId: string;
    status: SessionEndedPayload['status'];
  }): Promise<void>;
  /**
   * End (mark `done`) every non-terminal session for a device — called when the device is revoked. A revoked
   * device never reconnects, so the per-connection `session.reconcile` can never retire these; without this
   * they linger as phantom `running`/`awaiting_input` rows in the dashboard forever. Returns the ended
   * session ids so the caller can tell watching browsers (a live dashboard must clear without a refresh).
   */
  endSessionsForDevice(input: { userId: string; deviceId: string }): Promise<string[]>;
  /**
   * Sessions-ever per device for the user (RLS-scoped) — the "history size" a revoked device still
   * holds, shown in the web's Revoked section so revoking never looks like the history vanished.
   */
  countByDevice(userId: string): Promise<ReadonlyMap<string, number>>;
}

/** The columns {@link SessionSummary} carries, shared by the full-list and paged reads. */
const summaryColumns = {
  id: sessions.id,
  deviceId: sessions.deviceId,
  title: sessions.title,
  status: sessions.status,
  origin: sessions.origin,
  parentSessionId: sessions.parentSessionId,
  sealedMeta: sessions.sealedMeta,
  sealedMetaNonce: sessions.sealedMetaNonce,
  sealedTitle: sessions.sealedTitle,
  sealedTitleNonce: sessions.sealedTitleNonce,
  archivedAt: sessions.archivedAt,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
  endedAt: sessions.endedAt,
} as const;

const endStatuses = [...SESSION_END_STATUSES];

/**
 * The paged section's row scope: ended + un-archived by default; archived rows in the archived view.
 * The archived branch ALSO filters terminal — belt-and-suspenders with 0011's CHECK, so a non-terminal
 * row can never surface as "archived" no matter how archived_at got set.
 */
function pagedScopeFor(archived: boolean | undefined): SQL | undefined {
  return archived
    ? and(isNotNull(sessions.archivedAt), inArray(sessions.status, endStatuses))
    : and(inArray(sessions.status, endStatuses), isNull(sessions.archivedAt));
}

/** Keyset over (updated_at, id) — strictly after where the previous page stopped. */
function afterCursor(cursor: SessionPageCursor | undefined): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(sessions.updatedAt, cursor.updatedAt),
    and(eq(sessions.updatedAt, cursor.updatedAt), lt(sessions.id, cursor.id)),
  );
}

export function createSessionRegistry(db: DbHandle): SessionRegistry {
  /** Set a session's non-terminal status under the owner's RLS scope. No-op if the row isn't theirs. */
  async function setStatus(
    userId: string,
    sessionId: string,
    status: 'running' | 'awaiting_input',
  ): Promise<void> {
    await withUserContext(db, userId, async (scoped) => {
      await scoped
        .update(sessions)
        // A session coming back to life leaves the shelf: an archived `turn_limit` session is still
        // followable, and without clearing `archivedAt` here the resumed row would show on the live
        // board AND in the archived view at once (archived ⇒ terminal, enforced by 0011's CHECK —
        // this same UPDATE must clear the shelf or that constraint would reject the resume).
        .set({ status, archivedAt: null, updatedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
    });
  }

  /**
   * A terminal-only mutation's outcome: `ok` when the guarded write landed; otherwise a follow-up
   * existence read splits "still going" (`not_ended`) from "not yours / gone" (`not_found`).
   */
  async function resolveMissOutcome(
    scoped: Database,
    userId: string,
    sessionId: string,
  ): Promise<SessionMutationOutcome> {
    const [exists] = await scoped
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .limit(1);
    return exists ? 'not_ended' : 'not_found';
  }

  return {
    async createSession({
      userId,
      deviceId,
      origin,
      title,
      cwd,
      parentSessionId,
    }): Promise<string> {
      const sessionOrigin: SessionOrigin = origin ?? 'launched';
      // An adopted session is already running on the user's machine; a launched one is just starting.
      const status: SessionStatusName = sessionOrigin === 'external' ? 'running' : 'starting';
      return withUserContext(db, userId, async (scoped) => {
        // The parent link only lands when the parent is THE USER'S OWN row (RLS-scoped read). A
        // parentSessionId is browser-influenceable since T8 (`session.resume_new` names it), and the
        // raw FK alone would (a) let a crafted id link to another tenant's row and (b) leak whether an
        // arbitrary UUID exists (insert-succeeds vs FK-violation). Unknown/foreign → minted UNLINKED:
        // identical behavior either way, so there is nothing to probe.
        let verifiedParentId: string | undefined;
        if (parentSessionId !== undefined) {
          const [parent] = await scoped
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.id, parentSessionId), eq(sessions.userId, userId)))
            .limit(1);
          verifiedParentId = parent?.id;
        }
        const [row] = await scoped
          .insert(sessions)
          .values({
            userId,
            deviceId,
            origin: sessionOrigin,
            status,
            ...(title !== undefined ? { title } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
            ...(verifiedParentId !== undefined ? { parentSessionId: verifiedParentId } : {}),
          })
          .returning({ id: sessions.id });
        if (!row) {
          throw new Error('session insert returned no row');
        }
        return row.id;
      });
    },

    async listByUser(userId): Promise<SessionSummary[]> {
      return withUserContext(db, userId, async (scoped) => {
        return await scoped
          .select(summaryColumns)
          .from(sessions)
          // Defense in depth: RLS already scopes to the user; the explicit predicate keeps the read
          // correct even if the policy is toggled off (as some tests do), matching `setStatus`.
          .where(eq(sessions.userId, userId))
          .orderBy(desc(sessions.updatedAt), desc(sessions.id));
      });
    },

    async listPage({ userId, endedLimit, cursor, archived }): Promise<SessionPage> {
      return withUserContext(db, userId, async (scoped) => {
        const paged = await scoped
          .select(summaryColumns)
          .from(sessions)
          .where(and(eq(sessions.userId, userId), pagedScopeFor(archived), afterCursor(cursor)))
          .orderBy(desc(sessions.updatedAt), desc(sessions.id))
          // One extra row decides has-more without a count query.
          .limit(endedLimit + 1);
        const hasMore = paged.length > endedLimit;
        const page = hasMore ? paged.slice(0, endedLimit) : paged;
        const last = page[page.length - 1];
        const nextCursor = hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;

        // Active sessions ride only the FIRST page of the default view — a cursor'd caller (and the
        // archived view) already holds them; re-sending would duplicate rows client-side.
        const active =
          archived || cursor
            ? []
            : await scoped
                .select(summaryColumns)
                .from(sessions)
                .where(and(eq(sessions.userId, userId), notInArray(sessions.status, endStatuses)))
                .orderBy(desc(sessions.updatedAt), desc(sessions.id));

        return { sessions: [...active, ...page], nextCursor };
      });
    },

    async markRunning({ userId, sessionId }): Promise<void> {
      await setStatus(userId, sessionId, 'running');
    },

    async markAwaitingInput({ userId, sessionId }): Promise<void> {
      await setStatus(userId, sessionId, 'awaiting_input');
    },

    async setSealedMeta({ userId, sessionId, sealedMeta, sealedMetaNonce }): Promise<void> {
      await withUserContext(db, userId, async (scoped) => {
        await scoped
          .update(sessions)
          .set({ sealedMeta, sealedMetaNonce, updatedAt: new Date() })
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
      });
    },

    async setSealedTitle({
      userId,
      sessionId,
      sealedTitle,
      sealedTitleNonce,
    }): Promise<{ deviceId: string } | null> {
      return withUserContext(db, userId, async (scoped) => {
        const [updated] = await scoped
          .update(sessions)
          .set({ sealedTitle, sealedTitleNonce, updatedAt: new Date() })
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
          .returning({ deviceId: sessions.deviceId });
        return updated ?? null;
      });
    },

    async setArchived({ userId, sessionId, archived }): Promise<SessionMutationOutcome> {
      return withUserContext(db, userId, async (scoped) => {
        const [updated] = await scoped
          .update(sessions)
          // No updatedAt bump (AD-15): shelving isn't activity; unarchive restores true recency.
          .set({ archivedAt: archived ? new Date() : null })
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.userId, userId),
              // Terminal-only: a session that is still going can't be shelved out of sight.
              inArray(sessions.status, endStatuses),
            ),
          )
          .returning({ id: sessions.id });
        if (updated) return 'ok';
        return resolveMissOutcome(scoped, userId, sessionId);
      });
    },

    async deleteSession({ userId, sessionId }): Promise<SessionMutationOutcome> {
      return withUserContext(db, userId, async (scoped) => {
        const [deleted] = await scoped
          .delete(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.userId, userId),
              // Terminal-only: deleting a live session would strand a running agent unwatchable.
              inArray(sessions.status, endStatuses),
            ),
          )
          .returning({ id: sessions.id });
        if (deleted) return 'ok';
        return resolveMissOutcome(scoped, userId, sessionId);
      });
    },

    async markEnded({ userId, sessionId, status }): Promise<void> {
      const now = new Date();
      await withUserContext(db, userId, async (scoped) => {
        await scoped
          .update(sessions)
          .set({ status, endedAt: now, updatedAt: now })
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
      });
    },

    async endSessionsForDevice({ userId, deviceId }): Promise<string[]> {
      const now = new Date();
      return withUserContext(db, userId, async (scoped) => {
        const ended = await scoped
          .update(sessions)
          .set({ status: 'done', endedAt: now, updatedAt: now })
          .where(
            and(
              eq(sessions.userId, userId),
              eq(sessions.deviceId, deviceId),
              // EVERY non-terminal status. Unlike `session.reconcile` — which deliberately skips `starting`
              // so a fast-reconnecting daemon can still accept a just-forwarded launch — a revoked device is
              // gone for good (no daemon will ever reconnect on its token), so a `starting` or `offline_paused`
              // session on it can never progress and must be ended too. (`offline_paused` isn't persisted by
              // the relay today, but is listed so a revoked device is fully cleared if that ever changes.)
              inArray(sessions.status, ['starting', 'running', 'awaiting_input', 'offline_paused']),
            ),
          )
          .returning({ id: sessions.id });
        return ended.map((row) => row.id);
      });
    },

    async countByDevice(userId): Promise<ReadonlyMap<string, number>> {
      return withUserContext(db, userId, async (scoped) => {
        const rows = await scoped
          .select({ deviceId: sessions.deviceId, total: count() })
          .from(sessions)
          .where(eq(sessions.userId, userId))
          .groupBy(sessions.deviceId);
        return new Map(rows.map((row) => [row.deviceId, row.total]));
      });
    },
  };
}
