import { and, eq } from 'drizzle-orm';

import { type DbHandle } from '../db/client';
import { sessions } from '../db/schema';
import { withUserContext } from '../db/user-context';

/**
 * The relay's view of the session registry: it persists only routing metadata it can see on the
 * envelope (`user_id`, `device_id`, generated `session_id`, `status`) — never the launch payload, which
 * is opaque to the relay and encrypted in Phase 3. All writes go through {@link withUserContext} so RLS
 * scopes them to the owning user.
 */
export interface SessionRegistry {
  /** Insert a new `starting` session for the user/device and return its generated id. */
  createSession(input: { userId: string; deviceId: string }): Promise<string>;
  /** Flip a session to `running` once the daemon reports it started. No-op if the row isn't the user's. */
  markRunning(input: { userId: string; sessionId: string }): Promise<void>;
}

export function createSessionRegistry(db: DbHandle): SessionRegistry {
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

    async markRunning({ userId, sessionId }): Promise<void> {
      await withUserContext(db, userId, async (scoped) => {
        await scoped
          .update(sessions)
          .set({ status: 'running', updatedAt: new Date() })
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
      });
    },
  };
}
