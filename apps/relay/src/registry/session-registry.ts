import { type SessionStatusName } from '@telecode/protocol';
import { and, desc, eq } from 'drizzle-orm';

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
  /** Insert a new `starting` session for the user/device and return its generated id. */
  createSession(input: { userId: string; deviceId: string }): Promise<string>;
  /** List the user's sessions, newest first (RLS-scoped). Powers the dashboard list + reconnect. */
  listByUser(userId: string): Promise<SessionSummary[]>;
  /** Flip a session to `running` once the daemon reports it started. No-op if the row isn't the user's. */
  markRunning(input: { userId: string; sessionId: string }): Promise<void>;
  /** Flip a session to `awaiting_input` while a tool request blocks on a human decision. No-op if not the user's. */
  markAwaitingInput(input: { userId: string; sessionId: string }): Promise<void>;
  /** Mark a session terminal (`done`/`error`) with an end timestamp. No-op if the row isn't the user's. */
  markEnded(input: { userId: string; sessionId: string; status: 'done' | 'error' }): Promise<void>;
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
    async createSession({ userId, deviceId }): Promise<string> {
      return withUserContext(db, userId, async (scoped) => {
        const [row] = await scoped
          .insert(sessions)
          .values({ userId, deviceId, status: 'starting' })
          .returning({ id: sessions.id });
        if (!row) {
          throw new Error('session insert returned no row');
        }
        return row.id;
      });
    },

    async listByUser(userId): Promise<SessionSummary[]> {
      return withUserContext(db, userId, async (scoped) => {
        return (
          scoped
            .select({
              id: sessions.id,
              deviceId: sessions.deviceId,
              title: sessions.title,
              status: sessions.status,
              createdAt: sessions.createdAt,
              updatedAt: sessions.updatedAt,
              endedAt: sessions.endedAt,
            })
            .from(sessions)
            // Defense in depth: RLS already scopes to the user; the explicit predicate keeps the read
            // correct even if the policy is toggled off (as some tests do), matching `setStatus`.
            .where(eq(sessions.userId, userId))
            .orderBy(desc(sessions.createdAt))
        );
      });
    },

    async markRunning({ userId, sessionId }): Promise<void> {
      await setStatus(userId, sessionId, 'running');
    },

    async markAwaitingInput({ userId, sessionId }): Promise<void> {
      await setStatus(userId, sessionId, 'awaiting_input');
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
  };
}
