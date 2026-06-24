import { and, eq, isNull } from 'drizzle-orm';

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

export interface DeviceRegistry {
  /** Persist a paired device for the authenticated user; returns its generated id. */
  createDevice(input: {
    userId: string;
    name: string;
    deviceTokenHash: string;
    publicKey?: string;
  }): Promise<string>;
  /** Resolve a non-revoked device by its token hash (daemon authentication), or null. */
  findActiveByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
}

export function createDeviceRegistry(db: DbHandle): DeviceRegistry {
  return {
    async createDevice({ userId, name, deviceTokenHash, publicKey }): Promise<string> {
      return withUserContext(db, userId, async (scoped) => {
        const [row] = await scoped
          .insert(devices)
          .values({ userId, name, deviceTokenHash, publicKey: publicKey ?? null })
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
  };
}
