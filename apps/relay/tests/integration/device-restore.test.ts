import type { AddressInfo } from 'node:net';

import { makeEnvelope, WS_CLOSE_UNAUTHORIZED } from '@telecode/protocol';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { createSessionRegistry, type SessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectDaemon } from '../_helpers/ws';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Device-restore grant (UX Phase 4, walking skeleton): a daemon whose device was revoked proves
 * continuity by presenting its prior (revoked) device token on `POST /device/code`. When the SAME
 * user approves the new code, the relay restores the ORIGINAL device row — same `device_id`, cleared
 * `revoked_at`, rotated token hash — so session history stays attached and the machine keeps its
 * identity. Anything less than that proof (no prior token, another user approving) falls back to
 * today's behavior: a brand-new device row. Real relay + Postgres + WS.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

const PUBLIC_KEY = `${'A'.repeat(43)}=`;

interface CodeBody {
  device_code: string;
  user_code: string;
}
interface ApprovedPoll {
  status: string;
  device_token: string;
  device_id: string;
  user_id: string;
}

describe('device-restore grant: re-pairing a revoked device preserves its identity', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let registry: DeviceRegistry;
  let sessions: SessionRegistry;
  let app: FastifyInstance;
  let relayUrl: string;
  // Captured structured log lines — restore decisions must be triangulatable in production.
  const logLines: string[] = [];

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
      logger: pino(
        { level: 'info' },
        {
          write: (line: string) => {
            logLines.push(line);
          },
        },
      ),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
      deviceRegistry: registry,
      sessionRegistry: sessions,
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
  });

  /** Run the full grant (code → approve → poll) and return the approved credentials. */
  async function pairDevice(userId: string, body: Record<string, string>): Promise<ApprovedPoll> {
    const code = await app.inject({ method: 'POST', url: '/device/code', payload: body });
    expect(code.statusCode).toBe(200);
    const { device_code, user_code } = code.json<CodeBody>();

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
    expect(poll.statusCode).toBe(200);
    const result = poll.json<ApprovedPoll>();
    expect(result.status).toBe('approved');
    return result;
  }

  async function revoke(sessionToken: string, deviceId: string): Promise<void> {
    const del = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${deviceId}`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(del.statusCode).toBe(204);
  }

  it('restores the SAME device row: same id, revoked_at cleared, token rotated, history intact', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });

    // First pairing — the machine's original identity.
    const first = await pairDevice(alice.userId, {
      name: 'mbp',
      os: 'macOS 15.4',
      public_key: PUBLIC_KEY,
    });

    // The device accumulates history (a finished session), then gets revoked.
    const historySession = await sessions.createSession({
      userId: alice.userId,
      deviceId: first.device_id,
    });
    await sessions.markEnded({ userId: alice.userId, sessionId: historySession, status: 'done' });
    await revoke(alice.token, first.device_id);

    // Re-pair WITH restore evidence: the prior (now-revoked) device token.
    const second = await pairDevice(alice.userId, {
      name: 'mbp',
      os: 'macOS 15.4',
      public_key: PUBLIC_KEY,
      prior_device_token: first.device_token,
    });

    // The walking-skeleton assertion: the SAME device identity came back.
    expect(second.device_id).toBe(first.device_id);
    expect(second.device_token).not.toBe(first.device_token);

    // Exactly one device row exists — restored, not duplicated — and it is active again.
    const rows = await admin.query<{ id: string; revoked_at: Date | null }>(
      'select id, revoked_at from devices',
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.id).toBe(first.device_id);
    expect(rows.rows[0]?.revoked_at).toBeNull();

    // The history row still resolves to the restored device.
    const history = await sessions.listByUser(alice.userId);
    expect(history.find((s) => s.id === historySession)?.deviceId).toBe(first.device_id);

    // The restored device is back in the active list the web reads.
    const list = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const listed = list.json<{ devices: { id: string }[] }>().devices;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(first.device_id);

    // The rotated token authenticates a daemon hello on the same channel...
    const daemon = await connectDaemon(relayUrl, alice.userId, first.device_id, {
      token: second.device_token,
    });
    daemon.close();

    // ...and the dead prior token does not (closed 4001, same as any revoked credential).
    const stale = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      stale.once('open', () => resolve());
      stale.once('error', reject);
    });
    const closed = new Promise<number>((resolve, reject) => {
      stale.once('close', (code) => resolve(code));
      setTimeout(() => reject(new Error('relay did not close the stale-token socket')), 3000);
    });
    stale.send(
      JSON.stringify(
        makeEnvelope({
          type: 'hello',
          userId: alice.userId,
          deviceId: first.device_id,
          payload: { role: 'daemon', token: first.device_token },
        }),
      ),
    );
    expect(await closed).toBe(WS_CLOSE_UNAUTHORIZED);

    // Triangulation: the restore decision is in the structured logs, keyed by device_id — and no log
    // line ever contains a raw device token.
    const restoreLogs = logLines.filter((l) => l.includes('device restored'));
    expect(restoreLogs.some((l) => l.includes(first.device_id))).toBe(true);
    expect(logLines.some((l) => l.includes(first.device_token))).toBe(false);
    expect(logLines.some((l) => l.includes(second.device_token))).toBe(false);
  });

  it('creates a NEW device when a DIFFERENT user approves the restore code (no cross-account restore)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob' });

    const first = await pairDevice(alice.userId, { name: 'mbp' });
    await revoke(alice.token, first.device_id);

    // The machine re-pairs carrying alice's prior token, but BOB approves — the machine is being
    // handed to a different account. It must get a fresh identity under bob; alice's row stays revoked.
    const second = await pairDevice(bob.userId, {
      name: 'mbp',
      prior_device_token: first.device_token,
    });

    expect(second.device_id).not.toBe(first.device_id);
    expect(second.user_id).toBe(bob.userId);

    const aliceRow = await admin.query<{ revoked_at: Date | null }>(
      'select revoked_at from devices where id = $1',
      [first.device_id],
    );
    expect(aliceRow.rows[0]?.revoked_at).not.toBeNull();
  });

  it('creates a NEW device when no prior token is presented (plain re-pair, unchanged behavior)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });

    const first = await pairDevice(alice.userId, { name: 'mbp' });
    await revoke(alice.token, first.device_id);

    const second = await pairDevice(alice.userId, { name: 'mbp' });

    expect(second.device_id).not.toBe(first.device_id);
    const count = await admin.query<{ n: number }>('select count(*)::int as n from devices');
    expect(count.rows[0]?.n).toBe(2);
  });

  it('ignores an unknown prior token (garbage evidence → plain new pairing, not an error)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });

    const paired = await pairDevice(alice.userId, {
      name: 'mbp',
      prior_device_token: 'dt_never-existed',
    });

    expect(paired.status).toBe('approved');
    const count = await admin.query<{ n: number }>('select count(*)::int as n from devices');
    expect(count.rows[0]?.n).toBe(1);
  });

  it('ignores a still-ACTIVE token presented as evidence (restore is for revoked identities only)', async () => {
    // The trust anchor is possession of a REVOKED token. A live token must not let a pairing request
    // mutate the live device (token rotation / descriptor overwrite) — it degrades to a plain pair.
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });

    const live = await pairDevice(alice.userId, { name: 'mbp' });
    const second = await pairDevice(alice.userId, {
      name: 'imposter',
      prior_device_token: live.device_token,
    });

    expect(second.device_id).not.toBe(live.device_id);
    const liveRow = await admin.query<{ revoked_at: Date | null; name: string }>(
      'select revoked_at, name from devices where id = $1',
      [live.device_id],
    );
    expect(liveRow.rows[0]?.revoked_at).toBeNull();
    expect(liveRow.rows[0]?.name).toBe('mbp'); // untouched — no descriptor overwrite
    const count = await admin.query<{ n: number }>('select count(*)::int as n from devices');
    expect(count.rows[0]?.n).toBe(2);
  });

  it('the lifecycle repeats: revoke → restore → revoke → restore keeps ONE identity (history accrues)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });

    let token = (await pairDevice(alice.userId, { name: 'mbp' })).device_token;
    const first = await admin.query<{ id: string }>('select id from devices');
    const deviceId = first.rows[0]!.id;

    // Two full revoke → restore cycles; each accretes a session onto the same device id.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const s = await sessions.createSession({ userId: alice.userId, deviceId });
      await sessions.markEnded({ userId: alice.userId, sessionId: s, status: 'done' });
      await revoke(alice.token, deviceId);
      const restored = await pairDevice(alice.userId, {
        name: 'mbp',
        prior_device_token: token,
      });
      expect(restored.device_id).toBe(deviceId); // same identity every cycle
      token = restored.device_token; // the prior token rotated; the next cycle presents the new one
    }

    // Still exactly one device row, active, with all the accrued history attached.
    const rows = await admin.query<{ n: number }>('select count(*)::int as n from devices');
    expect(rows.rows[0]?.n).toBe(1);
    const history = await sessions.listByUser(alice.userId);
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.deviceId === deviceId)).toBe(true);
  });

  it('restores a device whose sessions the revoke cascade already ended (they stay ended)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const first = await pairDevice(alice.userId, { name: 'mbp' });

    // A running session at revoke time is cascaded to done; restoring the device must not revive it.
    const running = await sessions.createSession({
      userId: alice.userId,
      deviceId: first.device_id,
    });
    await sessions.markRunning({ userId: alice.userId, sessionId: running });
    await revoke(alice.token, first.device_id);

    const restored = await pairDevice(alice.userId, {
      name: 'mbp',
      prior_device_token: first.device_token,
    });
    expect(restored.device_id).toBe(first.device_id);
    const history = await sessions.listByUser(alice.userId);
    expect(history.find((s) => s.id === running)?.status).toBe('done');
  });
});
