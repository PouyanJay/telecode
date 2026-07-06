import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { hashDeviceToken } from '../../src/device-auth';
import { runMigrations } from '../../src/db/migrate';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { createSessionRegistry, type SessionRegistry } from '../../src/registry/session-registry';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * `session.resume_new` (ux Phase 6 T8), relay leg: the frame forwards browser→daemon like any session
 * action, but the relay must NOT flip the PARENT row to `running` — the parent stays exactly as it
 * ended (the child gets its own row via the daemon's `session.chained`). Contrast with `user.message`,
 * which deliberately resumes the row. Real relay, real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('relay: session.resume_new forwarding', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let devices: DeviceRegistry;
  let sessions: SessionRegistry;
  let relayUrl: string;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: 'channel-secret-test' });
    devices = createDeviceRegistry(handle);
    sessions = createSessionRegistry(handle);
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: 'svc-secret-test' },
      deviceRegistry: devices,
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

  it('forwards to the daemon and leaves the ENDED parent row untouched (never running)', async () => {
    const user = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const channelToken = await auth.mintChannelToken(user.userId);
    const deviceToken = 'daemon-token-alice';
    const deviceId = await devices.createDevice({
      userId: user.userId,
      name: 'alice-laptop',
      deviceTokenHash: hashDeviceToken(deviceToken),
    });
    const row = await admin.query<{ id: string }>(
      `insert into sessions (user_id, device_id, status, ended_at) values ($1, $2, 'needs_restart', now()) returning id`,
      [user.userId, deviceId],
    );
    const parentId = row.rows[0]!.id;

    const daemon = await connectDaemon(relayUrl, user.userId, deviceId, deviceToken);
    const browser = await connectBrowser(relayUrl, user.userId, deviceId, channelToken);
    try {
      const onForward = waitForEnvelope(daemon, (e) => e.type === 'session.resume_new');
      browser.send(
        JSON.stringify(
          makeEnvelope({
            type: 'session.resume_new',
            userId: user.userId,
            deviceId,
            sessionId: parentId,
            payload: { prompt: 'continue elsewhere', clientRef: 'ref-1' },
          }),
        ),
      );
      const forwarded = await onForward;
      expect(forwarded.session_id).toBe(parentId);
      expect(forwarded.payload).toEqual({ prompt: 'continue elsewhere', clientRef: 'ref-1' });

      // The parent must stay exactly as it ended — resume-as-new never revives the old row.
      const after = await admin.query<{ status: string }>(
        'select status from sessions where id = $1',
        [parentId],
      );
      expect(after.rows[0]!.status).toBe('needs_restart');
    } finally {
      daemon.close();
      browser.close();
    }
  });

  // T8 hardening: parentSessionId is browser-influenceable now — the link must be ownership-verified.
  it('links only the user’s OWN parent; a foreign or unknown parent id mints UNLINKED (no oracle)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice2' });
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob2' });
    const aliceDevice = await devices.createDevice({
      userId: alice.userId,
      name: 'alice2-laptop',
      deviceTokenHash: hashDeviceToken('tok-alice2'),
    });
    const bobDevice = await devices.createDevice({
      userId: bob.userId,
      name: 'bob2-laptop',
      deviceTokenHash: hashDeviceToken('tok-bob2'),
    });
    const aliceSession = await sessions.createSession({
      userId: alice.userId,
      deviceId: aliceDevice,
    });

    const readParent = async (id: string): Promise<string | null> => {
      const res = await admin.query<{ parent_session_id: string | null }>(
        'select parent_session_id from sessions where id = $1',
        [id],
      );
      return res.rows[0]!.parent_session_id;
    };

    // Bob names ALICE's session as parent → minted, but NEVER linked across tenants.
    const crossTenant = await sessions.createSession({
      userId: bob.userId,
      deviceId: bobDevice,
      parentSessionId: aliceSession,
    });
    expect(await readParent(crossTenant)).toBeNull();

    // An unknown UUID behaves IDENTICALLY (minted, unlinked) — existence is not probeable.
    const unknownParent = await sessions.createSession({
      userId: bob.userId,
      deviceId: bobDevice,
      parentSessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(await readParent(unknownParent)).toBeNull();

    // The user's own parent still links (the legitimate chained path).
    const bobParent = await sessions.createSession({ userId: bob.userId, deviceId: bobDevice });
    const linked = await sessions.createSession({
      userId: bob.userId,
      deviceId: bobDevice,
      parentSessionId: bobParent,
    });
    expect(await readParent(linked)).toBe(bobParent);
  });
});
