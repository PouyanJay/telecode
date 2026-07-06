import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  deviceCodeRequestSchema,
  type DeviceApproveResponse,
  type DeviceCodeResponse,
  type PollResult,
} from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';

import { constantTimeEquals } from './auth/secret-compare';
import { PAIRING_CODE_RATE_LIMIT, PAIRING_POLL_RATE_LIMIT } from './rate-limit';
import { type DeviceRegistry } from './registry/device-registry';

/**
 * Device Authorization Grant (RFC 8628). On approval the device is **persisted** to the registry under
 * the approving user (the raw token is returned once; only its SHA-256 hash is stored). Approval is
 * server-derived: `/device/approve` is called server-to-server by the web tier (service-secret guarded)
 * with the *authenticated* user's id — the client never supplies a user_id, closing the spike's hole.
 *
 * Pending (pre-approval) codes live in memory with a short TTL; only the approved device is persisted.
 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

export interface DeviceAuthOptions {
  verificationUri: string;
  registry: DeviceRegistry;
  expiresInMs?: number;
  intervalSec?: number;
  now?: () => number;
  /**
   * Brute-force lockout: after this many invalid approve attempts within `approveFailureWindowMs`, an
   * approving user is refused (defends a victim's short pending `user_code` against guessing). Defaults to
   * 10 failures / 10 minutes; the relay wires sensible defaults.
   */
  maxApproveFailures?: number;
  approveFailureWindowMs?: number;
  /** Structured logger for restore-lifecycle triangulation; token material is never logged. */
  logger?: Logger;
}

/** The outcome of an approve attempt: bound, invalid code, or the approver is brute-force locked out. */
export type ApproveOutcome = 'approved' | 'invalid' | 'rate_limited';

/** An approve attempt's outcome plus what it bound: a restored identity or a fresh device. */
export interface ApproveResult {
  readonly outcome: ApproveOutcome;
  /** True when the approval re-authorized an existing revoked device instead of inserting a new one. */
  readonly restored: boolean;
  /** The restored device's name for UI copy; null on anything but a restore. */
  readonly deviceName: string | null;
}

export interface DeviceAuthService {
  /**
   * Mint a pending code. When the caller presents `priorDeviceToken` (restore evidence from a revoked
   * device), it is verified against the registry NOW — a matching revoked row binds the pending code
   * to that device identity so approval can restore it instead of inserting a new row.
   */
  requestCode(input: {
    name?: string;
    publicKey?: string;
    os?: string;
    priorDeviceToken?: string;
  }): Promise<DeviceCodeResponse>;
  poll(deviceCode: string): PollResult;
  /** Persist + bind the device to `userId` (server-derived). See {@link ApproveResult}. */
  approve(userCode: string, userId: string): Promise<ApproveResult>;
  /**
   * Devices with a live, unapproved grant carrying VERIFIED restore evidence — the web's
   * "awaiting re-authorization" signal. A pure query: expired grants are skipped (their lazy
   * eviction stays with the poll/approve paths).
   */
  pendingRestoreDeviceIds(): readonly string[];
}

interface PendingRecord {
  userCode: string;
  expiresAt: number;
  name?: string;
  publicKey?: string;
  os?: string;
  approved: boolean;
  userId?: string;
  deviceId?: string;
  deviceToken?: string;
  /**
   * The single in-flight/settled bind for this record. Every approve call — including a concurrent
   * duplicate that lands mid-bind — awaits this same promise, so all of them report the one true
   * outcome (no second bind, no guessed `restored` flag).
   */
  binding?: Promise<ApproveResult>;
  /** Verified restore evidence: the revoked device this code can re-authorize, its owner, its name. */
  restoreDeviceId?: string;
  restoreUserId?: string;
  restoreDeviceName?: string;
}

function refusedResult(outcome: ApproveOutcome): ApproveResult {
  return { outcome, restored: false, deviceName: null };
}

function approvedResult(restored: boolean, record: PendingRecord): ApproveResult {
  return { outcome: 'approved', restored, deviceName: restored ? restoredName(record) : null };
}

/** The name the restored device ended up with: the re-pair request's, else the row's stored one. */
function restoredName(record: PendingRecord): string | null {
  return record.name ?? record.restoreDeviceName ?? null;
}

/** The descriptor fields the pairing request actually supplied (absent ones must not overwrite). */
function suppliedDescriptors(record: PendingRecord): {
  name?: string;
  publicKey?: string;
  os?: string;
} {
  return {
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.publicKey !== undefined ? { publicKey: record.publicKey } : {}),
    ...(record.os !== undefined ? { os: record.os } : {}),
  };
}

function generateUserCode(): string {
  // Reject bytes at/above the largest multiple of the alphabet length so `% length` stays unbiased.
  const maxUnbiased = 256 - (256 % USER_CODE_ALPHABET.length);
  const segment = (): string => {
    let chars = '';
    while (chars.length < 4) {
      for (const byte of randomBytes(8)) {
        if (chars.length >= 4) break;
        if (byte < maxUnbiased)
          chars += USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length);
      }
    }
    return chars;
  };
  return `${segment()}-${segment()}`;
}

/** SHA-256 hex hash of a device token. The raw token is never persisted. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Default brute-force lockout thresholds (see {@link DeviceAuthOptions}). */
export const DEFAULT_MAX_APPROVE_FAILURES = 10;
export const DEFAULT_APPROVE_FAILURE_WINDOW_MS = 10 * 60_000;

export function createDeviceAuthService(options: DeviceAuthOptions): DeviceAuthService {
  const now = options.now ?? ((): number => Date.now());
  const expiresInMs = options.expiresInMs ?? 5 * 60_000;
  const intervalSec = options.intervalSec ?? 1;
  const maxApproveFailures = options.maxApproveFailures ?? DEFAULT_MAX_APPROVE_FAILURES;
  const approveFailureWindowMs =
    options.approveFailureWindowMs ?? DEFAULT_APPROVE_FAILURE_WINDOW_MS;
  const byDeviceCode = new Map<string, PendingRecord>();
  const userCodeToDeviceCode = new Map<string, string>();
  // Recent invalid-approve timestamps per approving user, for the brute-force lockout.
  const approveFailures = new Map<string, number[]>();

  function expired(deviceCode: string, record: PendingRecord): boolean {
    if (now() > record.expiresAt) {
      byDeviceCode.delete(deviceCode);
      userCodeToDeviceCode.delete(record.userCode);
      return true;
    }
    return false;
  }

  /** Guards a victim's short user_code against distributed guessing. Prunes expired attempts as it reads. */
  function lockedOut(userId: string): boolean {
    const recent = (approveFailures.get(userId) ?? []).filter(
      (failedAt) => failedAt > now() - approveFailureWindowMs,
    );
    if (recent.length > 0) approveFailures.set(userId, recent);
    else approveFailures.delete(userId);
    return recent.length >= maxApproveFailures;
  }

  function recordFailure(userId: string): void {
    const recent = approveFailures.get(userId) ?? [];
    recent.push(now());
    approveFailures.set(userId, recent);
  }

  /**
   * Verify restore evidence against the registry. Only a token whose hash matches a REVOKED row binds
   * the pending code to that identity; unknown/active/garbage tokens degrade to a plain pair.
   */
  async function resolveRestoreEvidence(
    priorDeviceToken: string,
  ): Promise<Pick<PendingRecord, 'restoreDeviceId' | 'restoreUserId' | 'restoreDeviceName'>> {
    const revoked = await options.registry.findRevokedByTokenHash(
      hashDeviceToken(priorDeviceToken),
    );
    if (!revoked) {
      options.logger?.info(
        { restore_evidence: 'unverified' },
        'pairing request carried unverifiable restore evidence — plain pair',
      );
      return {};
    }
    options.logger?.info(
      { device_id: revoked.id, restore_evidence: 'verified' },
      'pairing code bound to verified restore evidence',
    );
    return {
      restoreDeviceId: revoked.id,
      restoreUserId: revoked.userId,
      restoreDeviceName: revoked.name,
    };
  }

  /**
   * Bind an approved code to a device row. Restore path: the code carries verified evidence for a
   * revoked device AND the approver is its owner → re-authorize the SAME row (identity + session
   * history preserved). Every other case — no evidence, or a different account approving (the machine
   * is being handed to someone else) — inserts a fresh device.
   */
  async function bindDevice(
    record: PendingRecord,
    userId: string,
    deviceTokenHash: string,
  ): Promise<{ deviceId: string; restored: boolean }> {
    if (record.restoreDeviceId !== undefined && record.restoreUserId === userId) {
      const restored = await options.registry.restoreDevice({
        userId,
        deviceId: record.restoreDeviceId,
        deviceTokenHash,
        ...suppliedDescriptors(record),
      });
      if (restored) {
        options.logger?.info(
          { device_id: record.restoreDeviceId, user_id: userId },
          'device restored: same identity re-authorized',
        );
        return { deviceId: record.restoreDeviceId, restored: true };
      }
      // The row vanished or was already restored under a different grant — fall through to a fresh insert.
      options.logger?.warn(
        { device_id: record.restoreDeviceId, user_id: userId },
        'verified restore evidence but the row was no longer restorable — issuing a fresh device',
      );
    }
    const deviceId = await options.registry.createDevice({
      userId,
      deviceTokenHash,
      ...suppliedDescriptors(record),
      name: record.name ?? 'device',
    });
    return { deviceId, restored: false };
  }

  /** Mint the token, bind the row, and stamp the record — the one bind every approve call awaits. */
  async function bindApproval(record: PendingRecord, userId: string): Promise<ApproveResult> {
    const rawToken = `dt_${randomBytes(24).toString('base64url')}`;
    const { deviceId, restored } = await bindDevice(record, userId, hashDeviceToken(rawToken));
    record.userId = userId;
    record.deviceId = deviceId;
    record.deviceToken = rawToken;
    return approvedResult(restored, record);
  }

  return {
    async requestCode({ name, publicKey, os, priorDeviceToken }): Promise<DeviceCodeResponse> {
      const deviceCode = randomUUID();
      const userCode = generateUserCode();
      const record: PendingRecord = {
        userCode,
        expiresAt: now() + expiresInMs,
        approved: false,
      };
      if (name !== undefined) record.name = name;
      if (publicKey !== undefined) record.publicKey = publicKey;
      if (os !== undefined) record.os = os;
      if (priorDeviceToken !== undefined) {
        Object.assign(record, await resolveRestoreEvidence(priorDeviceToken));
      }
      byDeviceCode.set(deviceCode, record);
      userCodeToDeviceCode.set(userCode, deviceCode);
      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: options.verificationUri,
        expires_in: Math.floor(expiresInMs / 1000),
        interval: intervalSec,
      };
    },

    poll(deviceCode): PollResult {
      const record = byDeviceCode.get(deviceCode);
      if (!record || expired(deviceCode, record)) {
        return { status: 'expired' };
      }
      if (
        record.approved &&
        record.deviceToken !== undefined &&
        record.userId !== undefined &&
        record.deviceId !== undefined
      ) {
        const result: PollResult = {
          status: 'approved',
          device_token: record.deviceToken,
          user_id: record.userId,
          device_id: record.deviceId,
        };
        // One-time delivery: consume the record so the raw token doesn't linger in memory for the
        // full TTL and a re-poll can't re-read it.
        byDeviceCode.delete(deviceCode);
        userCodeToDeviceCode.delete(record.userCode);
        return result;
      }
      return { status: 'authorization_pending' };
    },

    async approve(userCode, userId): Promise<ApproveResult> {
      if (lockedOut(userId)) return refusedResult('rate_limited');
      const deviceCode = userCodeToDeviceCode.get(userCode);
      if (deviceCode === undefined) {
        recordFailure(userId);
        return refusedResult('invalid');
      }
      const record = byDeviceCode.get(deviceCode);
      if (!record || expired(deviceCode, record)) {
        recordFailure(userId);
        return refusedResult('invalid');
      }
      // Idempotent re-approve — including a concurrent duplicate (web double-submit) landing while
      // the first bind is still in flight: everyone awaits the SAME bind and reports its outcome.
      if (record.binding) return record.binding;

      // Claim the record synchronously BEFORE anything awaits, so a duplicate takes the path above
      // rather than racing into a second device row.
      record.approved = true;
      record.binding = bindApproval(record, userId);
      try {
        return await record.binding;
      } catch (error) {
        // Release the claim so a retry can bind (duplicates awaiting this same promise also reject).
        record.approved = false;
        delete record.binding;
        throw error;
      }
    },

    pendingRestoreDeviceIds(): readonly string[] {
      return [...byDeviceCode.values()]
        .filter((record) => record.expiresAt >= now() && !record.approved)
        .flatMap((record) =>
          record.restoreDeviceId !== undefined ? [record.restoreDeviceId] : [],
        );
    },
  };
}

const tokenRequestSchema = z.object({ device_code: z.string().min(1) });
const approveRequestSchema = z.object({
  user_code: z.string().min(1),
  user_id: z.string().min(1),
});

/** Register the device-authorization endpoints. `/device/approve` is service-secret guarded. */
export function registerDeviceAuthRoutes(
  app: FastifyInstance,
  service: DeviceAuthService,
  serviceSecret: string,
): void {
  app.post(
    '/device/code',
    { config: { rateLimit: PAIRING_CODE_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = deviceCodeRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      return service.requestCode({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.public_key !== undefined ? { publicKey: parsed.data.public_key } : {}),
        ...(parsed.data.os !== undefined ? { os: parsed.data.os } : {}),
        ...(parsed.data.prior_device_token !== undefined
          ? { priorDeviceToken: parsed.data.prior_device_token }
          : {}),
      });
    },
  );

  app.post(
    '/device/token',
    { config: { rateLimit: PAIRING_POLL_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = tokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      return service.poll(parsed.data.device_code);
    },
  );

  app.post('/device/approve', async (request, reply) => {
    const secret = request.headers['x-telecode-service-secret'];
    if (typeof secret !== 'string' || !constantTimeEquals(secret, serviceSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = approveRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const result = await service.approve(parsed.data.user_code, parsed.data.user_id);
    if (result.outcome === 'rate_limited') {
      return reply.code(429).send({ error: 'too_many_attempts' });
    }
    if (result.outcome === 'invalid') {
      return reply.code(404).send({ error: 'invalid_user_code' });
    }
    // Typed against the shared contract so the route and the protocol schema cannot drift apart.
    const body: DeviceApproveResponse = {
      ok: true,
      restored: result.restored,
      device_name: result.deviceName,
    };
    return body;
  });
}
