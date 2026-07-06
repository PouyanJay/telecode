import {
  type SessionEndedPayload,
  type SessionOrigin,
  type SessionStatusName,
} from '@telecode/protocol';
import { and, count, desc, eq, inArray } from 'drizzle-orm';

import { type DbHandle } from '../db/client';
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
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly endedAt: Date | null;
}

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
  /** List the user's sessions, newest first (RLS-scoped). Powers the dashboard list + reconnect. */
  listByUser(userId: string): Promise<SessionSummary[]>;
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
        .set({ status, updatedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
    });
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
        const [row] = await scoped
          .insert(sessions)
          .values({
            userId,
            deviceId,
            origin: sessionOrigin,
            status,
            ...(title !== undefined ? { title } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
            ...(parentSessionId !== undefined ? { parentSessionId } : {}),
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
          .select({
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
            createdAt: sessions.createdAt,
            updatedAt: sessions.updatedAt,
            endedAt: sessions.endedAt,
          })
          .from(sessions)
          // Defense in depth: RLS already scopes to the user; the explicit predicate keeps the read
          // correct even if the policy is toggled off (as some tests do), matching `setStatus`.
          .where(eq(sessions.userId, userId))
          .orderBy(desc(sessions.createdAt));
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
