import type { DeviceApproveResponse } from '@telecode/protocol';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { createSessionRegistry, type SessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The revoked-devices surface (UX Phase 4): `GET /me/devices/revoked` keeps a revoked device visible —
 * with its history size and whether a verified re-authorization request is currently pending — so the
 * web can render the Revoked section and the "awaiting re-authorization" state. `/device/approve` now
 * reports whether the approval restored an existing device, so the activate page can say so.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

interface RevokedDeviceBody {
  id: string;
  name: string;
  os: string | null;
  revoked_at: string;
  session_count: number;
  pending_reauth: boolean;
}
describe('revoked-devices listing + restore-aware approve', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let registry: DeviceRegistry;
  let sessions: SessionRegistry;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: CHANNEL_SECRET });
    registry = createDeviceRegistry(handle);
    sessions = createSessionRegistry(handle);

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
      deviceRegistry: registry,
      sessionRegistry: sessions,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table users restart identity cascade');
  });

  /** Full grant: code (optionally with restore evidence) → approve → poll. */
  async function pairDevice(
    userId: string,
    body: Record<string, string>,
  ): Promise<{ device_id: string; device_token: string; approve: DeviceApproveResponse }> {
    const code = await app.inject({ method: 'POST', url: '/device/code', payload: body });
    const { device_code, user_code } = code.json<{ device_code: string; user_code: string }>();
    const approve = await app.inject({
      method: 'POST',
      url: '/device/approve',
      headers: { 'x-telecode-service-secret': SERVICE_SECRET },
      payload: { user_code, user_id: userId },
    });
    expect(approve.statusCode).toBe(200);
    const poll = await app.inject({
      method: 'POST',
      url: '/device/token',
      payload: { device_code },
    });
    const polled = poll.json<{ status: string; device_id: string; device_token: string }>();
    expect(polled.status).toBe('approved');
    return {
      device_id: polled.device_id,
      device_token: polled.device_token,
      approve: approve.json<DeviceApproveResponse>(),
    };
  }

  async function revoke(sessionToken: string, deviceId: string): Promise<void> {
    const del = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${deviceId}`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(del.statusCode).toBe(204);
  }

  async function listRevoked(sessionToken: string): Promise<RevokedDeviceBody[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/me/devices/revoked',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ devices: RevokedDeviceBody[] }>().devices;
  }

  it('lists only the authed user’s revoked devices, with history count and revoke time', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob' });

    const revoked = await pairDevice(alice.userId, { name: 'old-mbp', os: 'macOS 15.4' });
    const keeper = await pairDevice(alice.userId, { name: 'keeper' });
    const bobs = await pairDevice(bob.userId, { name: 'bob-box' });

    // History on the to-be-revoked device: one finished earlier, one still running at revoke time
    // (the cascade ends it) — both stay attached to the device row and count as history.
    const done = await sessions.createSession({
      userId: alice.userId,
      deviceId: revoked.device_id,
    });
    await sessions.markEnded({ userId: alice.userId, sessionId: done, status: 'done' });
    const running = await sessions.createSession({
      userId: alice.userId,
      deviceId: revoked.device_id,
    });
    await sessions.markRunning({ userId: alice.userId, sessionId: running });

    await revoke(alice.token, revoked.device_id);
    await revoke(bob.token, bobs.device_id);

    const listed = await listRevoked(alice.token);
    expect(listed).toHaveLength(1);
    const entry = listed[0]!;
    expect(entry.id).toBe(revoked.device_id);
    expect(entry.name).toBe('old-mbp');
    expect(entry.os).toBe('macOS 15.4');
    expect(new Date(entry.revoked_at).getTime()).toBeGreaterThan(0);
    expect(entry.session_count).toBe(2);
    expect(entry.pending_reauth).toBe(false);

    // The keeper stays in the active list and out of the revoked one.
    const active = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(active.json<{ devices: { id: string }[] }>().devices.map((d) => d.id)).toEqual([
      keeper.device_id,
    ]);
  });

  it('reports pending_reauth while a VERIFIED restore request is pending, and clears it after restore', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const first = await pairDevice(alice.userId, { name: 'mbp' });
    await revoke(alice.token, first.device_id);

    expect((await listRevoked(alice.token))[0]?.pending_reauth).toBe(false);

    // The daemon asks to re-pair with verified evidence → the row shows awaiting re-authorization.
    const code = await app.inject({
      method: 'POST',
      url: '/device/code',
      payload: { name: 'mbp', prior_device_token: first.device_token },
    });
    expect(code.statusCode).toBe(200);
    expect((await listRevoked(alice.token))[0]?.pending_reauth).toBe(true);

    // Unverifiable evidence never flags anything (and there is nothing to flag it on).
    const noise = await app.inject({
      method: 'POST',
      url: '/device/code',
      payload: { name: 'x', prior_device_token: 'dt_garbage' },
    });
    expect(noise.statusCode).toBe(200);

    // Completing the restore consumes the pending grant; the device is active again and gone from
    // the revoked list entirely.
    const { user_code, device_code } = code.json<{ user_code: string; device_code: string }>();
    await app.inject({
      method: 'POST',
      url: '/device/approve',
      headers: { 'x-telecode-service-secret': SERVICE_SECRET },
      payload: { user_code, user_id: alice.userId },
    });
    await app.inject({ method: 'POST', url: '/device/token', payload: { device_code } });
    expect(await listRevoked(alice.token)).toHaveLength(0);
  });

  it('approve reports restored=true + the device name for a restore, restored=false for a fresh pair', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });

    const fresh = await pairDevice(alice.userId, { name: 'mbp' });
    expect(fresh.approve).toMatchObject({ ok: true, restored: false, device_name: null });

    await revoke(alice.token, fresh.device_id);
    const restored = await pairDevice(alice.userId, {
      name: 'mbp',
      prior_device_token: fresh.device_token,
    });
    expect(restored.device_id).toBe(fresh.device_id);
    expect(restored.approve).toMatchObject({ ok: true, restored: true, device_name: 'mbp' });
  });

  it('reports the same restore outcome on an idempotent re-approve (double submit)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const first = await pairDevice(alice.userId, { name: 'mbp' });
    await revoke(alice.token, first.device_id);

    const code = await app.inject({
      method: 'POST',
      url: '/device/code',
      payload: { name: 'mbp', prior_device_token: first.device_token },
    });
    const { user_code } = code.json<{ user_code: string }>();
    const approveOnce = async (): Promise<DeviceApproveResponse> =>
      (
        await app.inject({
          method: 'POST',
          url: '/device/approve',
          headers: { 'x-telecode-service-secret': SERVICE_SECRET },
          payload: { user_code, user_id: alice.userId },
        })
      ).json<DeviceApproveResponse>();

    const firstApprove = await approveOnce();
    const secondApprove = await approveOnce();
    expect(firstApprove).toEqual({ ok: true, restored: true, device_name: 'mbp' });
    expect(secondApprove).toEqual(firstApprove);
    // Still exactly one device row — the duplicate never bound a second one.
    const count = await admin.query<{ n: number }>('select count(*)::int as n from devices');
    expect(count.rows[0]?.n).toBe(1);
  });

  it('lists revoked devices most-recently-revoked first, with 0 history for a never-used device', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const older = await pairDevice(alice.userId, { name: 'older' });
    const newer = await pairDevice(alice.userId, { name: 'newer' });

    await revoke(alice.token, older.device_id);
    // Force distinct revocation instants — two same-millisecond stamps would make the order flaky.
    await admin.query("update devices set revoked_at = revoked_at - interval '1 minute'", []);
    await revoke(alice.token, newer.device_id);

    const listed = await listRevoked(alice.token);
    expect(listed.map((d) => d.name)).toEqual(['newer', 'older']);
    // Degenerate history: neither device ever ran a session.
    expect(listed.map((d) => d.session_count)).toEqual([0, 0]);
  });

  it('rejects an unauthenticated revoked-devices request', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/devices/revoked' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/me/devices/revoked',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
  });
});
