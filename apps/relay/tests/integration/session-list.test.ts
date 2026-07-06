import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { createSessionRegistry, type SessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';

/**
 * Phase 2 Task 3 — the dashboard + reconnect need to enumerate a user's sessions over HTTP. `GET
 * /me/sessions` resolves the user from the bearer session token and returns only that user's sessions
 * (RLS-scoped), by last activity, as routing metadata (never the opaque launch payload). Real relay + PG.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

type SessionDto = {
  id: string;
  device_id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
};

describe('relay session listing: GET /me/sessions', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let devices: DeviceRegistry;
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
    devices = createDeviceRegistry(handle);
    sessions = createSessionRegistry(handle);

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
      deviceRegistry: devices,
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

  it('returns the user’s sessions by last activity (updated_at desc), scoped to that user', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob' });
    const aliceDevice = await devices.createDevice({
      userId: alice.userId,
      name: 'alice-laptop',
      deviceTokenHash: 'hash-a',
    });
    const bobDevice = await devices.createDevice({
      userId: bob.userId,
      name: 'bob-laptop',
      deviceTokenHash: 'hash-b',
    });

    // Three alice sessions with explicit ACTIVITY timestamps so the by-last-activity order (T7:
    // updated_at desc) is deterministic (one terminal, to exercise ended_at serialization) + one bob
    // session that must stay hidden from alice.
    const newer = await admin.query<{ id: string }>(
      `insert into sessions (user_id, device_id, title, status, cwd, created_at, updated_at)
       values ($1, $2, 'second task', 'awaiting_input', '/work/repo', now(), now()) returning id`,
      [alice.userId, aliceDevice],
    );
    const older = await admin.query<{ id: string }>(
      `insert into sessions (user_id, device_id, title, status, created_at, updated_at)
       values ($1, $2, 'first task', 'running', now() - interval '1 minute', now() - interval '1 minute') returning id`,
      [alice.userId, aliceDevice],
    );
    const ended = await admin.query<{ id: string }>(
      `insert into sessions (user_id, device_id, title, status, created_at, updated_at, ended_at)
       values ($1, $2, 'old task', 'done', now() - interval '2 minutes', now() - interval '2 minutes', now()) returning id`,
      [alice.userId, aliceDevice],
    );
    await admin.query(
      "insert into sessions (user_id, device_id, status) values ($1, $2, 'running')",
      [bob.userId, bobDevice],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/me/sessions',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sessions: SessionDto[] }>();

    // Only alice's three, most recent activity first, with routing metadata (bob's is absent).
    expect(body.sessions.map((s) => s.id)).toEqual([
      newer.rows[0]!.id,
      older.rows[0]!.id,
      ended.rows[0]!.id,
    ]);
    expect(body.sessions[0]).toMatchObject({
      id: newer.rows[0]!.id,
      device_id: aliceDevice,
      title: 'second task',
      status: 'awaiting_input',
      ended_at: null,
    });
    expect(typeof body.sessions[0]!.created_at).toBe('string');
    expect(typeof body.sessions[0]!.updated_at).toBe('string');
    expect(body.sessions[1]).toMatchObject({ title: 'first task', status: 'running' });
    // The terminal session round-trips ended_at as an ISO string.
    expect(body.sessions[2]).toMatchObject({ status: 'done' });
    expect(typeof body.sessions[2]!.ended_at).toBe('string');
    // The opaque launch payload (cwd, permission mode) is never surfaced, even though cwd is set.
    expect(body.sessions[0]).not.toHaveProperty('cwd');
    expect(body.sessions[0]).not.toHaveProperty('permission_mode');
  });

  it('returns an empty list for a user with no sessions', async () => {
    const carol = await auth.createSession({ provider: 'dev', providerUserId: 'carol' });
    const res = await app.inject({
      method: 'GET',
      url: '/me/sessions',
      headers: { authorization: `Bearer ${carol.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ sessions: unknown[] }>().sessions).toEqual([]);
  });

  it('rejects a request with no / invalid session token', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/sessions' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/me/sessions',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
  });
});
