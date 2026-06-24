import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  deviceCodeRequestSchema,
  type DeviceCodeResponse,
  type PollResult,
} from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

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
}

export interface DeviceAuthService {
  requestCode(input: { name?: string; publicKey?: string }): DeviceCodeResponse;
  poll(deviceCode: string): PollResult;
  /** Persist + bind the device to `userId` (server-derived). Resolves true if the code was valid. */
  approve(userCode: string, userId: string): Promise<boolean>;
}

interface PendingRecord {
  userCode: string;
  expiresAt: number;
  name?: string;
  publicKey?: string;
  approved: boolean;
  userId?: string;
  deviceId?: string;
  deviceToken?: string;
}

function generateUserCode(): string {
  const segment = (): string => {
    let out = '';
    for (const byte of randomBytes(4)) {
      out += USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length);
    }
    return out;
  };
  return `${segment()}-${segment()}`;
}

/** SHA-256 hex hash of a device token. The raw token is never persisted. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createDeviceAuthService(options: DeviceAuthOptions): DeviceAuthService {
  const now = options.now ?? ((): number => Date.now());
  const expiresInMs = options.expiresInMs ?? 5 * 60_000;
  const intervalSec = options.intervalSec ?? 1;
  const byDeviceCode = new Map<string, PendingRecord>();
  const userCodeToDeviceCode = new Map<string, string>();

  function expired(deviceCode: string, record: PendingRecord): boolean {
    if (now() > record.expiresAt) {
      byDeviceCode.delete(deviceCode);
      userCodeToDeviceCode.delete(record.userCode);
      return true;
    }
    return false;
  }

  return {
    requestCode({ name, publicKey }): DeviceCodeResponse {
      const deviceCode = randomUUID();
      const userCode = generateUserCode();
      const record: PendingRecord = {
        userCode,
        expiresAt: now() + expiresInMs,
        approved: false,
      };
      if (name !== undefined) record.name = name;
      if (publicKey !== undefined) record.publicKey = publicKey;
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
        return {
          status: 'approved',
          device_token: record.deviceToken,
          user_id: record.userId,
          device_id: record.deviceId,
        };
      }
      return { status: 'authorization_pending' };
    },

    async approve(userCode, userId): Promise<boolean> {
      const deviceCode = userCodeToDeviceCode.get(userCode);
      if (deviceCode === undefined) return false;
      const record = byDeviceCode.get(deviceCode);
      if (!record || expired(deviceCode, record)) return false;
      if (record.approved) return true; // idempotent

      const rawToken = `dt_${randomBytes(24).toString('base64url')}`;
      const deviceId = await options.registry.createDevice({
        userId,
        name: record.name ?? 'device',
        deviceTokenHash: hashDeviceToken(rawToken),
        ...(record.publicKey !== undefined ? { publicKey: record.publicKey } : {}),
      });
      record.approved = true;
      record.userId = userId;
      record.deviceId = deviceId;
      record.deviceToken = rawToken;
      return true;
    },
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
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
  app.post('/device/code', async (request, reply) => {
    const parsed = deviceCodeRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    return service.requestCode({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.public_key !== undefined ? { publicKey: parsed.data.public_key } : {}),
    });
  });

  app.post('/device/token', async (request, reply) => {
    const parsed = tokenRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    return service.poll(parsed.data.device_code);
  });

  app.post('/device/approve', async (request, reply) => {
    const secret = request.headers['x-telecode-service-secret'];
    if (typeof secret !== 'string' || !constantTimeEquals(secret, serviceSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = approveRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (!(await service.approve(parsed.data.user_code, parsed.data.user_id))) {
      return reply.code(404).send({ error: 'invalid_user_code' });
    }
    return { ok: true };
  });
}
