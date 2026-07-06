import type { AddressInfo } from 'node:net';

import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
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
 * Session housekeeping (ux Phase 6 T7), relay leg. `GET /me/sessions` orders by last activity
 * (`updated_at` desc) and paginates ENDED sessions with an opaque keyset cursor — active sessions are
 * always returned in full, so live counts can never be short. Archive (`PATCH :id/archive`) is a soft,
 * reversible shelving (`archived_at`) that hides a TERMINAL session from the default list; delete
 * (`DELETE :id`) permanently removes the row AND evicts the session's ciphertext replay cache. Both are
 * terminal-only (409 otherwise) and RLS-scoped (cross-user → 404). Real relay, real Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL;

interface WireSession {
  id: string;
  status: string;
  archived_at: string | null;
  updated_at: string;
}

interface SessionListBody {
  sessions: WireSession[];
  next_cursor: string | null;
}

describe('session housekeeping: GET pagination + archive + delete', () => {
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

  /** A user + device, returning ids and the user's session/channel + device tokens. */
  async function seedUser(providerUserId: string): Promise<{
    userId: string;
    token: string;
    channelToken: string;
    deviceId: string;
    deviceToken: string;
  }> {
    const user = await auth.createSession({ provider: 'dev', providerUserId });
    const channelToken = await auth.mintChannelToken(user.userId);
    const deviceToken = `daemon-token-${providerUserId}`;
    const deviceId = await devices.createDevice({
      userId: user.userId,
      name: `${providerUserId}-laptop`,
      deviceTokenHash: hashDeviceToken(deviceToken),
    });
    return { userId: user.userId, token: user.token, channelToken, deviceId, deviceToken };
  }

  /** Insert one session row directly, with an explicit status and updated_at (pagination needs order). */
  async function seedSessionRow(input: {
    userId: string;
    deviceId: string;
    status: string;
    updatedAt: string;
    parentSessionId?: string;
    archived?: boolean;
  }): Promise<string> {
    const res = await admin.query<{ id: string }>(
      `insert into sessions (user_id, device_id, status, updated_at, ended_at, parent_session_id, archived_at)
       values ($1, $2, $3, $4, case when $3 in ('done','error','turn_limit','needs_restart') then $4::timestamptz else null end, $5,
               case when $6 then $4::timestamptz else null end)
       returning id`,
      [
        input.userId,
        input.deviceId,
        input.status,
        input.updatedAt,
        input.parentSessionId ?? null,
        input.archived ?? false,
      ],
    );
    return res.rows[0]!.id;
  }

  async function listSessions(
    token: string,
    query = '',
  ): Promise<{ statusCode: number; body: SessionListBody }> {
    const res = await app.inject({
      method: 'GET',
      url: `/me/sessions${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { statusCode: res.statusCode, body: res.json<SessionListBody>() };
  }

  async function archive(
    token: string,
    sessionId: string,
    archived: boolean,
  ): Promise<{ statusCode: number }> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/me/sessions/${sessionId}/archive`,
      headers: { authorization: `Bearer ${token}` },
      payload: { archived },
    });
    return { statusCode: res.statusCode };
  }

  async function destroy(token: string, sessionId: string): Promise<{ statusCode: number }> {
    const res = await app.inject({
      method: 'DELETE',
      url: `/me/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { statusCode: res.statusCode };
  }

  describe('ordering + pagination', () => {
    it('orders the list by last activity (updated_at desc), not creation time', async () => {
      const alice = await seedUser('alice');
      const seed = { userId: alice.userId, deviceId: alice.deviceId, status: 'running' };
      const oldest = await seedSessionRow({ ...seed, updatedAt: '2026-07-01T10:00:00Z' });
      const newest = await seedSessionRow({ ...seed, updatedAt: '2026-07-03T10:00:00Z' });
      const middle = await seedSessionRow({ ...seed, updatedAt: '2026-07-02T10:00:00Z' });

      const { body } = await listSessions(alice.token);
      expect(body.sessions.map((s) => s.id)).toEqual([newest, middle, oldest]);
    });

    it('returns active sessions in full and paginates ended ones behind an opaque cursor', async () => {
      const alice = await seedUser('alice');
      const base = { userId: alice.userId, deviceId: alice.deviceId };
      const active = await seedSessionRow({
        ...base,
        status: 'running',
        updatedAt: '2026-07-01T00:00:00Z', // older than every ended row — active must STILL be returned
      });
      const ended: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ended.push(
          await seedSessionRow({
            ...base,
            status: 'done',
            updatedAt: `2026-07-02T0${i}:00:00Z`,
          }),
        );
      }
      const newestFirst = [...ended].reverse();

      // Page 1: ALL active + the 2 most recent ended + a cursor.
      const page1 = await listSessions(alice.token, '?limit=2');
      expect(page1.statusCode).toBe(200);
      const page1Ids = page1.body.sessions.map((s) => s.id);
      expect(page1Ids).toContain(active);
      expect(page1Ids.filter((id) => ended.includes(id))).toEqual(newestFirst.slice(0, 2));
      expect(page1.body.next_cursor).not.toBeNull();

      // Page 2: the next 2 ended only (no active re-sent, no duplicates).
      const page2 = await listSessions(
        alice.token,
        `?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor!)}`,
      );
      expect(page2.body.sessions.map((s) => s.id)).toEqual(newestFirst.slice(2, 4));
      expect(page2.body.next_cursor).not.toBeNull();

      // Page 3: the final row, and the cursor drains to null.
      const page3 = await listSessions(
        alice.token,
        `?limit=2&cursor=${encodeURIComponent(page2.body.next_cursor!)}`,
      );
      expect(page3.body.sessions.map((s) => s.id)).toEqual(newestFirst.slice(4));
      expect(page3.body.next_cursor).toBeNull();
    });

    it('pages stably through rows with identical updated_at (id keyset tiebreak — no skips, no dups)', async () => {
      const alice = await seedUser('alice');
      const base = { userId: alice.userId, deviceId: alice.deviceId, status: 'done' };
      const sameInstant = '2026-07-02T12:00:00Z';
      const ids = new Set<string>();
      for (let i = 0; i < 5; i += 1) {
        ids.add(await seedSessionRow({ ...base, updatedAt: sameInstant }));
      }

      const seen = new Set<string>();
      let cursor: string | null = null;
      let hops = 0;
      do {
        const query: string =
          cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
        const { body } = await listSessions(alice.token, query);
        for (const s of body.sessions) {
          expect(seen.has(s.id)).toBe(false); // no duplicates across pages
          seen.add(s.id);
        }
        cursor = body.next_cursor;
        hops += 1;
      } while (cursor !== null && hops < 10);
      expect(seen).toEqual(ids); // no skips
    });

    it('pages the ARCHIVED view with the same keyset mechanics', async () => {
      const alice = await seedUser('alice');
      const base = { userId: alice.userId, deviceId: alice.deviceId, status: 'done' };
      const archivedIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        archivedIds.push(
          await seedSessionRow({ ...base, updatedAt: `2026-07-02T0${i}:00:00Z`, archived: true }),
        );
      }
      // Noise the archived view must exclude: an un-archived ended row.
      await seedSessionRow({ ...base, updatedAt: '2026-07-02T06:00:00Z' });
      const newestFirst = [...archivedIds].reverse();

      const page1 = await listSessions(alice.token, '?archived=true&limit=2');
      expect(page1.body.sessions.map((s) => s.id)).toEqual(newestFirst.slice(0, 2));
      const page2 = await listSessions(
        alice.token,
        `?archived=true&limit=2&cursor=${encodeURIComponent(page1.body.next_cursor!)}`,
      );
      expect(page2.body.sessions.map((s) => s.id)).toEqual(newestFirst.slice(2, 4));
      const page3 = await listSessions(
        alice.token,
        `?archived=true&limit=2&cursor=${encodeURIComponent(page2.body.next_cursor!)}`,
      );
      expect(page3.body.sessions.map((s) => s.id)).toEqual(newestFirst.slice(4));
      expect(page3.body.next_cursor).toBeNull();
    });

    it('rejects a malformed cursor (400)', async () => {
      const alice = await seedUser('alice');
      const { statusCode } = await listSessions(alice.token, '?cursor=not-a-cursor');
      expect(statusCode).toBe(400);
    });

    it('rejects a cursor from the OTHER view (400 — fails closed, never a skewed page)', async () => {
      const alice = await seedUser('alice');
      const base = { userId: alice.userId, deviceId: alice.deviceId, status: 'done' };
      for (let i = 0; i < 3; i += 1) {
        await seedSessionRow({ ...base, updatedAt: `2026-07-02T0${i}:00:00Z` });
      }
      const endedPage = await listSessions(alice.token, '?limit=2');
      expect(endedPage.body.next_cursor).not.toBeNull();
      const crossed = await listSessions(
        alice.token,
        `?archived=true&cursor=${encodeURIComponent(endedPage.body.next_cursor!)}`,
      );
      expect(crossed.statusCode).toBe(400);
    });

    it('rejects an out-of-range or non-numeric limit (400)', async () => {
      const alice = await seedUser('alice');
      expect((await listSessions(alice.token, '?limit=0')).statusCode).toBe(400);
      expect((await listSessions(alice.token, '?limit=999')).statusCode).toBe(400);
      expect((await listSessions(alice.token, '?limit=abc')).statusCode).toBe(400);
    });
  });

  describe('archive / unarchive', () => {
    it('archives a terminal session: hidden from the default list, listed under ?archived=true', async () => {
      const alice = await seedUser('alice');
      const base = { userId: alice.userId, deviceId: alice.deviceId };
      const endedId = await seedSessionRow({
        ...base,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      const keptId = await seedSessionRow({
        ...base,
        status: 'error',
        updatedAt: '2026-07-01T00:00:00Z',
      });

      expect((await archive(alice.token, endedId, true)).statusCode).toBe(204);

      const defaultList = await listSessions(alice.token);
      expect(defaultList.body.sessions.map((s) => s.id)).toEqual([keptId]);

      const archivedList = await listSessions(alice.token, '?archived=true');
      expect(archivedList.body.sessions.map((s) => s.id)).toEqual([endedId]);
      expect(archivedList.body.sessions[0]!.archived_at).not.toBeNull();
    });

    it('unarchive restores the row to the default list at its original recency (updated_at untouched)', async () => {
      const alice = await seedUser('alice');
      const updatedAt = '2026-07-02T00:00:00Z';
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'done',
        updatedAt,
      });

      await archive(alice.token, id, true);
      expect((await archive(alice.token, id, false)).statusCode).toBe(204);

      const list = await listSessions(alice.token);
      const row = list.body.sessions.find((s) => s.id === id);
      expect(row).toBeDefined();
      expect(row!.archived_at).toBeNull();
      // Shelving is not activity (AD-15): the row keeps its true last-activity position.
      expect(new Date(row!.updated_at).toISOString()).toBe(new Date(updatedAt).toISOString());
    });

    it('refuses to archive a session that is still going (409, row untouched)', async () => {
      const alice = await seedUser('alice');
      for (const status of ['running', 'awaiting_input', 'starting']) {
        const id = await seedSessionRow({
          userId: alice.userId,
          deviceId: alice.deviceId,
          status,
          updatedAt: '2026-07-02T00:00:00Z',
        });
        expect((await archive(alice.token, id, true)).statusCode).toBe(409);
        const row = await admin.query<{ archived_at: string | null }>(
          'select archived_at from sessions where id = $1',
          [id],
        );
        expect(row.rows[0]!.archived_at).toBeNull();
      }
    });

    it('a resumed session leaves the shelf: following up un-archives it (never live AND archived)', async () => {
      const alice = await seedUser('alice');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'turn_limit', // followable ending — the composer can resume it after an archive
        updatedAt: '2026-07-02T00:00:00Z',
      });
      await archive(alice.token, id, true);

      // A follow-up flips it running (what the relay does when routing user.message).
      await sessions.markRunning({ userId: alice.userId, sessionId: id });

      // The row is live again and OFF the shelf — on the default list, absent from the archived view.
      const row = await admin.query<{ status: string; archived_at: string | null }>(
        'select status, archived_at from sessions where id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ status: 'running', archived_at: null });
      const archivedList = await listSessions(alice.token, '?archived=true');
      expect(archivedList.body.sessions.map((s) => s.id)).not.toContain(id);
      const defaultList = await listSessions(alice.token);
      expect(defaultList.body.sessions.map((s) => s.id)).toContain(id);
    });

    it('the DB itself refuses a live-but-archived row (0011 CHECK backstop)', async () => {
      const alice = await seedUser('alice');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      await archive(alice.token, id, true);
      // Even a superuser write that flips an archived row live without clearing the shelf must fail.
      await expect(
        admin.query("update sessions set status = 'running' where id = $1", [id]),
      ).rejects.toThrow(/sessions_archived_terminal/);
    });

    it('refuses to archive another user’s session (RLS-scoped 404)', async () => {
      const alice = await seedUser('alice');
      const bob = await seedUser('bob');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      expect((await archive(bob.token, id, true)).statusCode).toBe(404);
    });

    it('rejects an unauthenticated archive (401)', async () => {
      const alice = await seedUser('alice');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/me/sessions/${id}/archive`,
        payload: { archived: true },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 for an unknown session and 400 for a non-uuid id', async () => {
      const alice = await seedUser('alice');
      expect(
        (await archive(alice.token, '00000000-0000-0000-0000-000000000000', true)).statusCode,
      ).toBe(404);
      expect((await archive(alice.token, 'not-a-uuid', true)).statusCode).toBe(400);
    });

    it('rejects a malformed archive body (400, row untouched)', async () => {
      const alice = await seedUser('alice');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      for (const payload of [{ archived: 'yes' }, {}, { shelved: true }]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/me/sessions/${id}/archive`,
          headers: { authorization: `Bearer ${alice.token}` },
          payload,
        });
        expect(res.statusCode).toBe(400);
      }
      const row = await admin.query<{ archived_at: string | null }>(
        'select archived_at from sessions where id = $1',
        [id],
      );
      expect(row.rows[0]!.archived_at).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes a terminal session permanently (row gone)', async () => {
      const alice = await seedUser('alice');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'turn_limit',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      expect((await destroy(alice.token, id)).statusCode).toBe(204);
      const row = await admin.query('select id from sessions where id = $1', [id]);
      expect(row.rowCount).toBe(0);
    });

    it('refuses to delete a session that is still going (409, row remains)', async () => {
      const alice = await seedUser('alice');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'running',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      expect((await destroy(alice.token, id)).statusCode).toBe(409);
      const row = await admin.query('select id from sessions where id = $1', [id]);
      expect(row.rowCount).toBe(1);
    });

    it('refuses to delete another user’s session (RLS-scoped 404, row remains)', async () => {
      const alice = await seedUser('alice');
      const bob = await seedUser('bob');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      expect((await destroy(bob.token, id)).statusCode).toBe(404);
      const row = await admin.query('select id from sessions where id = $1', [id]);
      expect(row.rowCount).toBe(1);
    });

    it('returns 404 for an unknown session and 400 for a non-uuid id', async () => {
      const alice = await seedUser('alice');
      expect((await destroy(alice.token, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(
        404,
      );
      expect((await destroy(alice.token, 'not-a-uuid')).statusCode).toBe(400);
    });

    it('rejects an unauthenticated delete (401, row remains)', async () => {
      const alice = await seedUser('alice');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
      });
      const res = await app.inject({ method: 'DELETE', url: `/me/sessions/${id}` });
      expect(res.statusCode).toBe(401);
      const row = await admin.query('select id from sessions where id = $1', [id]);
      expect(row.rowCount).toBe(1);
    });

    it('deleting a parent detaches its continuation (FK set null), never cascade-deletes it', async () => {
      const alice = await seedUser('alice');
      const base = { userId: alice.userId, deviceId: alice.deviceId };
      const parent = await seedSessionRow({
        ...base,
        status: 'done',
        updatedAt: '2026-07-01T00:00:00Z',
      });
      const child = await seedSessionRow({
        ...base,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
        parentSessionId: parent,
      });

      expect((await destroy(alice.token, parent)).statusCode).toBe(204);
      const row = await admin.query<{ parent_session_id: string | null }>(
        'select parent_session_id from sessions where id = $1',
        [child],
      );
      expect(row.rowCount).toBe(1);
      expect(row.rows[0]!.parent_session_id).toBeNull();
    });

    it('evicts the session’s ciphertext replay cache — a fresh subscribe replays nothing', async () => {
      const alice = await seedUser('alice');
      const id = await seedSessionRow({
        userId: alice.userId,
        deviceId: alice.deviceId,
        status: 'done',
        updatedAt: '2026-07-02T00:00:00Z',
      });

      const daemon = await connectDaemon(relayUrl, alice.userId, alice.deviceId, alice.deviceToken);
      const watcher = await connectBrowser(
        relayUrl,
        alice.userId,
        alice.deviceId,
        alice.channelToken,
      );
      try {
        // Prime the cache: a live watcher receiving a frame proves the relay cached it first.
        watcher.send(
          JSON.stringify(
            makeEnvelope({
              type: 'session.subscribe',
              userId: alice.userId,
              deviceId: alice.deviceId,
              sessionId: id,
              payload: {},
            }),
          ),
        );
        await waitForEnvelope(daemon, (e) => e.type === 'session.subscribe');
        for (const [type, payload] of [
          ['session.key', 'CIPHER_KEY'],
          ['agent.message', 'CIPHER_MSG'],
        ] as const) {
          daemon.send(
            JSON.stringify(
              makeEnvelope({
                type,
                userId: alice.userId,
                deviceId: alice.deviceId,
                sessionId: id,
                payload,
                nonce: 'nonce',
              }),
            ),
          );
        }
        await waitForEnvelope(watcher, (e) => e.type === 'agent.message'); // received live ⇒ cached

        expect((await destroy(alice.token, id)).statusCode).toBe(204);

        // A browser reopening after the delete must get NO replayed ciphertext. The relay forwards
        // the subscribe to the daemon AFTER replaying, so the forwarded subscribe is the barrier.
        const reopened = await connectBrowser(
          relayUrl,
          alice.userId,
          alice.deviceId,
          alice.channelToken,
        );
        try {
          const got: Envelope[] = [];
          reopened.on('message', (raw: Buffer) =>
            got.push(parseEnvelope(JSON.parse(raw.toString()))),
          );
          reopened.send(
            JSON.stringify(
              makeEnvelope({
                type: 'session.subscribe',
                userId: alice.userId,
                deviceId: alice.deviceId,
                sessionId: id,
                payload: {},
              }),
            ),
          );
          await waitForEnvelope(daemon, (e) => e.type === 'session.subscribe');
          expect(
            got.filter((e) => e.type === 'session.key' || e.type === 'agent.message'),
          ).toHaveLength(0);
        } finally {
          reopened.close();
        }
      } finally {
        daemon.close();
        watcher.close();
      }
    });
  });
});
