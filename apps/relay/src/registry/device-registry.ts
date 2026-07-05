import { and, desc, eq, isNull } from 'drizzle-orm';

import { type DbHandle } from '../db/client';
import { devices } from '../db/schema';
import { withUserContext } from '../db/user-context';

/**
 * The device registry (Postgres). A device is created at pairing under the approving user's RLS scope;
 * only the SHA-256 hash of its long-lived token is stored. The lookup used to authenticate a connecting
 * daemon runs on the trusted owner connection — at `hello` time there is no user context yet (the daemon
 * is the thing being authenticated).
 */
export interface DeviceRecord {
  readonly id: string;
  readonly userId: string;
  readonly revokedAt: Date | null;
}

/** A user-facing device summary (the browser targets `id`; `name`/`os` are shown in the UI). */
export interface ActiveDevice {
  readonly id: string;
  readonly name: string;
  /** Short OS descriptor (e.g. "macOS 15.4"); null for devices paired before OS reporting. */
  readonly os: string | null;
  readonly lastSeenAt: Date | null;
  /** The device's X25519 public key (base64) for E2E key exchange; null for devices paired pre-E2E. */
  readonly publicKey: string | null;
}

export interface DeviceRegistry {
  /** Persist a paired device for the authenticated user; returns its generated id. */
  createDevice(input: {
    userId: string;
    name: string;
    deviceTokenHash: string;
    publicKey?: string;
    os?: string;
  }): Promise<string>;
  /** Resolve a non-revoked device by its token hash (daemon authentication), or null. */
  findActiveByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  /**
   * Stamp a device's `last_seen_at` (daemon connected/disconnected). Runs on the trusted owner
   * connection keyed by primary key — like `findActiveByTokenHash`, it executes at `hello` time where
   * no user context exists yet, and it can only touch the one presence column.
   */
  touchLastSeen(deviceId: string): Promise<void>;
  /** List a user's non-revoked devices (newest first) under their RLS scope, for the web to target. */
  findActiveByUser(userId: string): Promise<ActiveDevice[]>;
  /**
   * Revoke a device for the authenticated user (sets `revoked_at`), under their RLS scope so a user can
   * only revoke their own. Returns true if a still-active device was revoked, false if none matched.
   */
  revoke(userId: string, deviceId: string): Promise<boolean>;
}

export function createDeviceRegistry(db: DbHandle): DeviceRegistry {
  return {
    async createDevice({ userId, name, deviceTokenHash, publicKey, os }): Promise<string> {
      return withUserContext(db, userId, async (scoped) => {
        const [row] = await scoped
          .insert(devices)
          .values({ userId, name, deviceTokenHash, publicKey: publicKey ?? null, os: os ?? null })
          .returning({ id: devices.id });
        if (!row) {
          throw new Error('device insert returned no row');
        }
        return row.id;
      });
    },

    async findActiveByTokenHash(tokenHash): Promise<DeviceRecord | null> {
      const [row] = await db.db
        .select({ id: devices.id, userId: devices.userId, revokedAt: devices.revokedAt })
        .from(devices)
        .where(and(eq(devices.deviceTokenHash, tokenHash), isNull(devices.revokedAt)))
        .limit(1);
      return row ?? null;
    },

    async touchLastSeen(deviceId): Promise<void> {
      await db.db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));
    },

    async findActiveByUser(userId): Promise<ActiveDevice[]> {
      return withUserContext(db, userId, async (scoped) =>
        scoped
          .select({
            id: devices.id,
            name: devices.name,
            os: devices.os,
            lastSeenAt: devices.lastSeenAt,
            publicKey: devices.publicKey,
          })
          .from(devices)
          .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
          .orderBy(desc(devices.createdAt)),
      );
    },

    async revoke(userId, deviceId): Promise<boolean> {
      return withUserContext(db, userId, async (scoped) => {
        const revoked = await scoped
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)),
          )
          .returning({ id: devices.id });
        return revoked.length > 0;
      });
    },
  };
}
