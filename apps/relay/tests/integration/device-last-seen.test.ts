import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { hashDeviceToken } from '../../src/device-auth';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { buildRelay } from '../../src/relay';
import { connectDaemon } from '../_helpers/ws';

/**
 * Device presence honesty (UX honesty pass, T1): `devices.last_seen_at` must reflect reality. The relay
 * stamps it when a daemon registers (hello) and again when it disconnects, so "last seen" in the UI is
 * real data instead of the permanent null it has been. Real relay + real Postgres + real WS.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const DEVICE_TOKEN = 'dt_last-seen-test-token';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('relay: devices.last_seen_at stamping', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let registry: DeviceRegistry;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;

  async function lastSeenAt(id: string): Promise<Date | null> {
    const res = await admin.query<{ last_seen_at: Date | null }>(
      'select last_seen_at from devices where id = $1',
      [id],
    );
    return res.rows[0]?.last_seen_at ?? null;
  }

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    registry = createDeviceRegistry(handle);

    app = await buildRelay({ logger: pino({ level: 'silent' }), deviceRegistry: registry });
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
      "insert into users (provider, provider_user_id) values ('dev', 'last-seen') returning id",
    );
    userId = u.rows[0]!.id;
    deviceId = await registry.createDevice({
      userId,
      name: 'stamped-laptop',
      deviceTokenHash: hashDeviceToken(DEVICE_TOKEN),
    });
  });

  it('touchLastSeen stamps the column (registry primitive)', async () => {
    expect(await lastSeenAt(deviceId)).toBeNull();
    await registry.touchLastSeen(deviceId);
    const seen = await lastSeenAt(deviceId);
    expect(seen).not.toBeNull();
    expect(Date.now() - seen!.getTime()).toBeLessThan(5000);
  });

  it('stamps last_seen_at when the daemon registers (hello.ack implies the stamp)', async () => {
    expect(await lastSeenAt(deviceId)).toBeNull();
    const daemon = await connectDaemon(relayUrl, userId, deviceId, DEVICE_TOKEN);
    // hello.ack already received inside connectDaemon — the stamp must be visible now, no polling.
    const seen = await lastSeenAt(deviceId);
    expect(seen).not.toBeNull();
    daemon.close();
  });

  it('stamps last_seen_at again when the daemon disconnects', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId, DEVICE_TOKEN);
    const atHello = await lastSeenAt(deviceId);
    expect(atHello).not.toBeNull();
    // Let the clock move past the hello stamp so the disconnect stamp is distinguishable.
    await sleep(25);
    daemon.close();
    await expect
      .poll(async () => (await lastSeenAt(deviceId))?.getTime(), { timeout: 3000 })
      .toBeGreaterThan(atHello!.getTime());
  });

  it('does not stamp on a rejected hello (invalid device token)', async () => {
    const socket = new (await import('ws')).default(relayUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(
      JSON.stringify(
        makeEnvelope({
          type: 'hello',
          userId,
          deviceId,
          payload: { role: 'daemon', token: 'dt_wrong-token' },
        }),
      ),
    );
    expect(await closed).toBe(4001);
    expect(await lastSeenAt(deviceId)).toBeNull();
  });

  it('keeps serving hello even if the stamp write fails (presence must not block registration)', async () => {
    // A registry whose touch always fails — registration must still succeed and ack.
    const flaky: DeviceRegistry = {
      ...registry,
      touchLastSeen: () => Promise.reject(new Error('db hiccup')),
    };
    const flakyApp = await buildRelay({ logger: pino({ level: 'silent' }), deviceRegistry: flaky });
    await flakyApp.listen({ port: 0, host: '127.0.0.1' });
    const flakyUrl = `ws://127.0.0.1:${(flakyApp.server.address() as AddressInfo).port}/ws`;
    // connectDaemon resolves only on hello.ack — registration succeeded despite the failed stamp.
    const daemon = await connectDaemon(flakyUrl, userId, deviceId, DEVICE_TOKEN);
    daemon.close();
    await flakyApp.close();
    expect(await lastSeenAt(deviceId)).toBeNull();
  });
});
