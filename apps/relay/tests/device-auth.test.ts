import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createDaemon, type Daemon } from '@telecode/daemon';
import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthService } from '../src/auth/auth-service';
import { createDb, type DbHandle } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { DEFAULT_MAX_APPROVE_FAILURES, hashDeviceToken } from '../src/device-auth';
import { createDeviceRegistry } from '../src/registry/device-registry';
import { buildRelay } from '../src/relay';

/**
 * Device pairing through the real stack: a daemon requests a code, the (authenticated) web approves it
 * server-derived, the device is persisted (token stored only as a hash), and a daemon presenting that
 * token authenticates its WS connection while a bogus token is rejected.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-device-test';
const VERIFICATION_URI = 'https://app.example.test/activate';

interface CodeResponse {
  user_code: string;
  device_code: string;
}

describe('device pairing: persisted, server-derived approval + daemon token auth', () => {
  let handle: DbHandle;
  let admin: Pool;
  let app: FastifyInstance;
  let relayUrl: string;
  let userId: string;

  async function requestCode(name: string, publicKey?: string): Promise<CodeResponse> {
    const res = await app.inject({
      method: 'POST',
      url: '/device/code',
      payload: { name, ...(publicKey !== undefined ? { public_key: publicKey } : {}) },
    });
    return res.json<CodeResponse>();
  }

  async function approve(userCode: string, secret: string | null): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/device/approve',
      headers: secret === null ? {} : { 'x-telecode-service-secret': secret },
      payload: { user_code: userCode, user_id: userId },
    });
    return res.statusCode;
  }

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      verificationUri: VERIFICATION_URI,
      auth: {
        service: createAuthService({ db: handle, channelTokenSecret: 'chan-secret' }),
        serviceSecret: SERVICE_SECRET,
      },
      deviceRegistry: createDeviceRegistry(handle),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table users restart identity cascade');
    const u = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'pair') returning id",
    );
    userId = u.rows[0]!.id;
  });

  it('returns the configured verification_uri in the device code (so the daemon prompt is correct)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/device/code',
      payload: { name: 'laptop' },
    });
    expect(res.json<{ verification_uri: string }>().verification_uri).toBe(VERIFICATION_URI);
  });

  it('persists a device on server-derived approval and stores only the token hash', async () => {
    const { user_code, device_code } = await requestCode('alice-laptop', 'cGstYmFzZTY0');

    const pending = await app.inject({
      method: 'POST',
      url: '/device/token',
      payload: { device_code },
    });
    expect(pending.json()).toMatchObject({ status: 'authorization_pending' });

    expect(await approve(user_code, null)).toBe(401); // no service secret
    expect(await approve(user_code, SERVICE_SECRET)).toBe(200);

    const polled = await app.inject({
      method: 'POST',
      url: '/device/token',
      payload: { device_code },
    });
    const result = polled.json<{
      status: string;
      device_token: string;
      user_id: string;
      device_id: string;
    }>();
    expect(result.status).toBe('approved');
    expect(result.device_token).toMatch(/^dt_/);
    expect(result.user_id).toBe(userId);
    expect(result.device_id).toMatch(/^[0-9a-f-]{36}$/);

    const row = await admin.query<{
      user_id: string;
      public_key: string;
      device_token_hash: string;
    }>('select user_id, public_key, device_token_hash from devices where id = $1', [
      result.device_id,
    ]);
    expect(row.rows[0]?.user_id).toBe(userId);
    expect(row.rows[0]?.public_key).toBe('cGstYmFzZTY0');
    expect(row.rows[0]?.device_token_hash).toBe(hashDeviceToken(result.device_token));
    expect(row.rows[0]?.device_token_hash).not.toBe(result.device_token);
  });

  it('authenticates a daemon with its device token and rejects a bogus one', async () => {
    const { user_code, device_code } = await requestCode('lap');
    await approve(user_code, SERVICE_SECRET);
    const approved = (
      await app.inject({ method: 'POST', url: '/device/token', payload: { device_code } })
    ).json<{ device_token: string; device_id: string }>();

    // Valid token → the real daemon client connects (resolves on hello.ack).
    let daemon: Daemon | undefined;
    try {
      daemon = createDaemon({
        relayUrl,
        userId,
        deviceId: approved.device_id,
        deviceToken: approved.device_token,
        logger: pino({ level: 'silent' }),
      });
      await daemon.start();
    } finally {
      await daemon?.stop();
    }

    // Bogus token → the relay closes the socket with 4001.
    const socket = new WebSocket(relayUrl);
    const closed = new Promise<number>((resolve, reject) => {
      socket.on('close', (code: number) => resolve(code));
      socket.on('message', () => reject(new Error('unexpected ack — should be rejected')));
      setTimeout(() => reject(new Error('socket not closed')), 3000);
    });
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));
    socket.send(
      JSON.stringify(
        makeEnvelope({
          type: 'hello',
          userId,
          deviceId: approved.device_id,
          payload: { role: 'daemon', token: 'dt_bogus' },
        }),
      ),
    );
    expect(await closed).toBe(4001);
  });

  it('returns 429 from /device/approve once an approver is brute-force locked out', async () => {
    // A synthetic approver id keeps this test's failures isolated from the rest of the suite. The invalid
    // code path is refused before the registry is touched, so no real user row is needed.
    const approver = `lockout-${randomUUID()}`;
    const badCode = 'ZZZZ-ZZZZ';
    const approveBad = async (): Promise<number> =>
      (
        await app.inject({
          method: 'POST',
          url: '/device/approve',
          headers: { 'x-telecode-service-secret': SERVICE_SECRET },
          payload: { user_code: badCode, user_id: approver },
        })
      ).statusCode;

    const beforeLockout: number[] = [];
    for (let i = 0; i < DEFAULT_MAX_APPROVE_FAILURES; i += 1) {
      beforeLockout.push(await approveBad());
    }

    // Every attempt within the budget is a plain invalid-code 404; the next one is refused with 429.
    expect(beforeLockout).toEqual(Array<number>(DEFAULT_MAX_APPROVE_FAILURES).fill(404));
    expect(await approveBad()).toBe(429);
  });
});
