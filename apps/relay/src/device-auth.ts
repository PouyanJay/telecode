import { randomBytes, randomUUID } from 'node:crypto';

import type { DeviceCodeResponse, PollResult } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Device Authorization Grant (RFC 8628), self-contained for Phase 0: the relay issues device/user
 * codes and a device token directly. Real GitHub/Google OAuth + the web `/activate` screen + X25519
 * pubkey registration land in later phases — this spike only proves the round-trip:
 *   daemon → POST /device/code → (user approves) → daemon polls /device/token → device token issued.
 *
 * Phase 0 uses JSON bodies and a 200 `authorization_pending` status for simplicity; the strict
 * RFC form-encoding + 400 error codes can come with the real provider.
 */

const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

export interface DeviceAuthOptions {
  verificationUri: string;
  expiresInMs?: number;
  intervalSec?: number;
  now?: () => number;
}

export interface DeviceAuthService {
  requestCode(): DeviceCodeResponse;
  poll(deviceCode: string): PollResult;
  approve(userCode: string, userId: string): boolean;
}

interface PendingRecord {
  userCode: string;
  expiresAt: number;
  approved: boolean;
  userId?: string;
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

export function createDeviceAuthService(options: DeviceAuthOptions): DeviceAuthService {
  const now = options.now ?? (() => Date.now());
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
    requestCode(): DeviceCodeResponse {
      const deviceCode = randomUUID();
      const userCode = generateUserCode();
      byDeviceCode.set(deviceCode, { userCode, expiresAt: now() + expiresInMs, approved: false });
      userCodeToDeviceCode.set(userCode, deviceCode);
      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: options.verificationUri,
        expires_in: Math.floor(expiresInMs / 1000),
        interval: intervalSec,
      };
    },

    poll(deviceCode: string): PollResult {
      const record = byDeviceCode.get(deviceCode);
      if (!record || expired(deviceCode, record)) {
        return { status: 'expired' };
      }
      if (record.approved && record.deviceToken !== undefined && record.userId !== undefined) {
        return { status: 'approved', device_token: record.deviceToken, user_id: record.userId };
      }
      return { status: 'authorization_pending' };
    },

    approve(userCode: string, userId: string): boolean {
      const deviceCode = userCodeToDeviceCode.get(userCode);
      if (deviceCode === undefined) return false;
      const record = byDeviceCode.get(deviceCode);
      if (!record || expired(deviceCode, record)) return false;
      record.approved = true;
      record.userId = userId;
      record.deviceToken = `dt_${randomBytes(24).toString('base64url')}`;
      return true;
    },
  };
}

const tokenRequestSchema = z.object({ device_code: z.string().min(1) });
const approveRequestSchema = z.object({
  user_code: z.string().min(1),
  user_id: z.string().min(1),
});

/** Register the device-authorization HTTP endpoints on the relay. */
export function registerDeviceAuthRoutes(app: FastifyInstance, service: DeviceAuthService): void {
  app.post('/device/code', async () => service.requestCode());

  app.post('/device/token', async (request, reply) => {
    const parsed = tokenRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    return service.poll(parsed.data.device_code);
  });

  app.post('/device/approve', async (request, reply) => {
    const parsed = approveRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (!service.approve(parsed.data.user_code, parsed.data.user_id)) {
      return reply.code(404).send({ error: 'invalid_user_code' });
    }
    return { ok: true };
  });
}
