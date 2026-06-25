import { and, eq } from 'drizzle-orm';

import { type DbHandle } from '../db/client';
import { pushSubscriptions } from '../db/schema';
import { type StoredPushSubscription } from './push-sender';

/**
 * Persists the user's web-push subscriptions (the `push_subscriptions` table). Relay-managed — the
 * subscription is a routing secret the relay uses to deliver notifications — so all access runs on the
 * owner connection (NOT `withUserContext`), and the table is RLS-locked deny-all to the user-scoped role.
 */
export interface PushSubscriptionStore {
  /** Upsert a subscription (keyed by its unique endpoint) for the user. */
  save(input: { userId: string; endpoint: string; p256dh: string; auth: string }): Promise<void>;
  /** The user's subscriptions, to deliver a notification to each. */
  listByUser(userId: string): Promise<StoredPushSubscription[]>;
  /** Remove a subscription (on unsubscribe, or when the push service reports it gone). Scoped to the user. */
  deleteByEndpoint(input: { userId: string; endpoint: string }): Promise<void>;
}

export function createPushSubscriptionStore(db: DbHandle): PushSubscriptionStore {
  return {
    async save({ userId, endpoint, p256dh, auth }): Promise<void> {
      // Owner connection (push_subscriptions is owner-only). Re-subscribing the same endpoint updates it.
      await db.db
        .insert(pushSubscriptions)
        .values({ userId, endpoint, p256dh, auth })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { userId, p256dh, auth },
        });
    },

    async listByUser(userId): Promise<StoredPushSubscription[]> {
      return db.db
        .select({
          endpoint: pushSubscriptions.endpoint,
          p256dh: pushSubscriptions.p256dh,
          auth: pushSubscriptions.auth,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));
    },

    async deleteByEndpoint({ userId, endpoint }): Promise<void> {
      await db.db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
    },
  };
}
