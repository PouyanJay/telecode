import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { hashDeviceToken } from '../../src/device-auth';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Device presence honesty (UX honesty pass, T1): `devices.last_seen_at` must reflect reality. The relay
 * stamps it when a daemon registers (hello) and again when it disconnects, so "last seen" in the UI is
 * real data instead of the permanent null it has been. Real relay + real Postgres + real WS. The
 * registry gets a deterministic monotonic clock so stamp ordering is assertable without wall-clock
 * sleeps (each stamp is one injected second apart).
 */
const DATABASE_URL = process.env.DATABASE_URL;
const DEVICE_TOKEN = 'dt_last-seen-test-token';
const CLOCK_BASE_MS = new Date('2026-07-05T12:00:00Z').getTime();

describe('relay: devices.last_seen_at stamping', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let registry: DeviceRegistry;
  let relayUrl: string;
  let userId: string;
  let deviceId: string;
  let clockTicks = 0;

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
    registry = createDeviceRegistry(handle, () => new Date(CLOCK_BASE_MS + ++clockTicks * 1000));

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

  it('touchLastSeen stamps the column with the injected clock (registry primitive)', async () => {
    expect(await lastSeenAt(deviceId)).toBeNull();
    const before = clockTicks;
    await registry.touchLastSeen(deviceId);
    expect((await lastSeenAt(deviceId))?.getTime()).toBe(CLOCK_BASE_MS + (before + 1) * 1000);
  });

  it('stamps last_seen_at when the daemon registers', async () => {
    expect(await lastSeenAt(deviceId)).toBeNull();
    const daemon = await connectDaemon(relayUrl, userId, deviceId, { token: DEVICE_TOKEN });
    // The stamp is fire-and-forget (registration never waits on it), so poll for it to land.
    await expect
      .poll(async () => (await lastSeenAt(deviceId)) !== null, { timeout: 3000 })
      .toBe(true);
    daemon.close();
  });

  it('stamps last_seen_at again when the daemon disconnects', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId, { token: DEVICE_TOKEN });
    // The hello stamp is fire-and-forget — wait for it to land before using it as the baseline. The
    // injected clock is strictly monotonic (one second per stamp), so the disconnect stamp is
    // distinguishable with no wall-clock dependency.
    await expect
      .poll(async () => (await lastSeenAt(deviceId)) !== null, { timeout: 3000 })
      .toBe(true);
    const atHello = (await lastSeenAt(deviceId))!;
    daemon.close();
    await expect
      .poll(async () => (await lastSeenAt(deviceId))?.getTime(), { timeout: 3000 })
      .toBeGreaterThan(atHello.getTime());
  });

  it('does not stamp on a rejected hello (invalid device token)', async () => {
    const socket = new WebSocket(relayUrl);
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
    const daemon = await connectDaemon(flakyUrl, userId, deviceId, { token: DEVICE_TOKEN });
    daemon.close();
    await flakyApp.close();
    expect(await lastSeenAt(deviceId)).toBeNull();
  });

  it('still broadcasts offline presence when the disconnect stamp fails (teardown must not block)', async () => {
    const flaky: DeviceRegistry = {
      ...registry,
      touchLastSeen: () => Promise.reject(new Error('db hiccup')),
    };
    const flakyApp = await buildRelay({ logger: pino({ level: 'silent' }), deviceRegistry: flaky });
    await flakyApp.listen({ port: 0, host: '127.0.0.1' });
    const flakyUrl = `ws://127.0.0.1:${(flakyApp.server.address() as AddressInfo).port}/ws`;

    const browser = await connectBrowser(flakyUrl, userId, deviceId);
    const online = waitForEnvelope(
      browser,
      (e) => e.type === 'device.presence' && (e.payload as { online: boolean }).online,
    );
    const daemon = await connectDaemon(flakyUrl, userId, deviceId, { token: DEVICE_TOKEN });
    await online;

    // The daemon drops; its stamp write rejects — watching browsers must still be told it went offline.
    const offline = waitForEnvelope(
      browser,
      (e) => e.type === 'device.presence' && !(e.payload as { online: boolean }).online,
    );
    daemon.close();
    await offline;

    browser.close();
    await flakyApp.close();
    expect(await lastSeenAt(deviceId)).toBeNull();
  });
});
