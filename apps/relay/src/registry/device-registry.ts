import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

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
  readonly name: string;
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

/** A revoked device as the web's Revoked section shows it — still visible, identity intact. */
export interface RevokedDevice {
  readonly id: string;
  readonly name: string;
  readonly os: string | null;
  readonly revokedAt: Date;
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
   * Resolve a REVOKED device by its token hash, or null. Restore evidence: a re-pairing daemon proves
   * continuity with its prior (revoked) token so approval can re-authorize the same row. Like
   * `findActiveByTokenHash` this runs on the trusted owner connection — it executes at `/device/code`
   * time where no user context exists yet (the caller is the thing being re-authenticated).
   */
  findRevokedByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  /**
   * Stamp a device's `last_seen_at` (daemon connected/disconnected). Runs on the trusted owner
   * connection keyed by primary key — like `findActiveByTokenHash`, it executes at `hello` time where
   * no user context exists yet, and it can only touch the one presence column.
   */
  touchLastSeen(deviceId: string): Promise<void>;
  /** List a user's non-revoked devices (newest first) under their RLS scope, for the web to target. */
  findActiveByUser(userId: string): Promise<ActiveDevice[]>;
  /** List a user's revoked devices (most recently revoked first) under their RLS scope. */
  findRevokedByUser(userId: string): Promise<RevokedDevice[]>;
  /**
   * Revoke a device for the authenticated user (sets `revoked_at`), under their RLS scope so a user can
   * only revoke their own. Returns true if a still-active device was revoked, false if none matched.
   */
  revoke(userId: string, deviceId: string): Promise<boolean>;
  /**
   * Re-authorize a revoked device for the authenticated user: clear `revoked_at` and rotate the token
   * hash on the SAME row, so the device keeps its id (and every session that references it). Descriptor
   * fields are refreshed only when the re-pairing daemon supplied them. RLS-scoped like `revoke`.
   * Returns true if a revoked device was restored, false if none matched.
   */
  restoreDevice(input: {
    userId: string;
    deviceId: string;
    deviceTokenHash: string;
    name?: string;
    publicKey?: string;
    os?: string;
  }): Promise<boolean>;
}

/** `clock` is injectable so presence-stamp ordering is testable without wall-clock sleeps. */
export function createDeviceRegistry(
  db: DbHandle,
  clock: () => Date = () => new Date(),
): DeviceRegistry {
  // Shared by the two token-hash lookups (daemon auth wants a live row, restore evidence wants a
  // revoked one). Runs on the trusted owner connection — no user context exists at hello/pairing time.
  async function findByTokenHash(
    tokenHash: string,
    revokedPredicate: typeof isNull | typeof isNotNull,
  ): Promise<DeviceRecord | null> {
    const [row] = await db.db
      .select({
        id: devices.id,
        userId: devices.userId,
        name: devices.name,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(and(eq(devices.deviceTokenHash, tokenHash), revokedPredicate(devices.revokedAt)))
      .limit(1);
    return row ?? null;
  }

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

    findActiveByTokenHash: (tokenHash) => findByTokenHash(tokenHash, isNull),

    findRevokedByTokenHash: (tokenHash) => findByTokenHash(tokenHash, isNotNull),

    async touchLastSeen(deviceId): Promise<void> {
      // Monotonic: both call sites (hello, disconnect) are fire-and-forget, so two in-flight stamps
      // from a flapping connection have no guaranteed completion order — greatest() ensures the column
      // never regresses to the earlier one.
      await db.db
        .update(devices)
        .set({
          lastSeenAt: sql`greatest(coalesce(${devices.lastSeenAt}, to_timestamp(0)), ${clock()})`,
        })
        .where(eq(devices.id, deviceId));
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

    async findRevokedByUser(userId): Promise<RevokedDevice[]> {
      return withUserContext(db, userId, async (scoped) => {
        const rows = await scoped
          .select({
            id: devices.id,
            name: devices.name,
            os: devices.os,
            revokedAt: devices.revokedAt,
          })
          .from(devices)
          .where(and(eq(devices.userId, userId), isNotNull(devices.revokedAt)))
          .orderBy(desc(devices.revokedAt));
        // The isNotNull predicate guarantees revokedAt; narrow it for the domain type.
        return rows.flatMap((row) => (row.revokedAt ? [{ ...row, revokedAt: row.revokedAt }] : []));
      });
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

    async restoreDevice({ userId, deviceId, deviceTokenHash, name, publicKey, os }) {
      return withUserContext(db, userId, async (scoped) => {
        const restored = await scoped
          .update(devices)
          .set({
            revokedAt: null,
            deviceTokenHash,
            ...(name !== undefined ? { name } : {}),
            ...(publicKey !== undefined ? { publicKey } : {}),
            ...(os !== undefined ? { os } : {}),
          })
          .where(
            and(eq(devices.id, deviceId), eq(devices.userId, userId), isNotNull(devices.revokedAt)),
          )
          .returning({ id: devices.id });
        return restored.length > 0;
      });
    },
  };
}
