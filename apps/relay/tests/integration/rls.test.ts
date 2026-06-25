import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import {
  authSessions,
  devices,
  oauthTokens,
  pushSubscriptions,
  sessions,
  users,
} from '../../src/db/schema';
import { withUserContext } from '../../src/db/user-context';

/**
 * Proves Row Level Security genuinely isolates per user: with the registries created and RLS enabled,
 * a user acting through {@link withUserContext} can see and mutate only their own rows. Real Postgres,
 * no mocks. The admin pool connects as the superuser (bypasses RLS) purely to seed and to assert ground
 * truth out-of-band.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('RLS isolation across the registries', () => {
  let handle: DbHandle;
  let admin: Pool;
  let userA: string;
  let userB: string;
  let deviceA: string;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    // Superuser bypasses RLS; cascade clears devices + sessions too.
    await admin.query('truncate table users restart identity cascade');
    const a = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'alice') returning id",
    );
    const b = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'bob') returning id",
    );
    userA = a.rows[0]!.id;
    userB = b.rows[0]!.id;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'alice-laptop', 'h') returning id",
      [userA],
    );
    deviceA = d.rows[0]!.id;
  });

  it('lets a user insert their own session and read it back', async () => {
    const created = await withUserContext(handle, userA, async (db) => {
      const [row] = await db
        .insert(sessions)
        .values({ userId: userA, deviceId: deviceA })
        .returning();
      return row;
    });
    expect(created?.userId).toBe(userA);
    expect(created?.status).toBe('starting');

    const aSees = await withUserContext(handle, userA, (db) => db.select().from(sessions));
    expect(aSees).toHaveLength(1);
  });

  it("hides one user's session from another user", async () => {
    await withUserContext(handle, userA, (db) =>
      db.insert(sessions).values({ userId: userA, deviceId: deviceA }).returning(),
    );

    const bSees = await withUserContext(handle, userB, (db) => db.select().from(sessions));
    expect(bSees).toHaveLength(0);
  });

  it('forbids inserting a session owned by another user (WITH CHECK)', async () => {
    await expect(
      withUserContext(handle, userB, (db) =>
        db.insert(sessions).values({ userId: userA, deviceId: deviceA }).returning(),
      ),
    ).rejects.toThrow();
  });

  it("forbids updating another user's session (row is invisible)", async () => {
    const created = await withUserContext(handle, userA, async (db) => {
      const [row] = await db
        .insert(sessions)
        .values({ userId: userA, deviceId: deviceA })
        .returning();
      return row;
    });

    const updated = await withUserContext(handle, userB, (db) =>
      db
        .update(sessions)
        .set({ title: 'hijacked' })
        .where(eq(sessions.id, created!.id))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const truth = await admin.query<{ title: string | null }>(
      'select title from sessions where id = $1',
      [created!.id],
    );
    expect(truth.rows[0]?.title).toBeNull();
  });

  it("forbids deleting another user's session (row is invisible)", async () => {
    const created = await withUserContext(handle, userA, async (db) => {
      const [row] = await db
        .insert(sessions)
        .values({ userId: userA, deviceId: deviceA })
        .returning();
      return row;
    });

    const deleted = await withUserContext(handle, userB, (db) =>
      db.delete(sessions).where(eq(sessions.id, created!.id)).returning(),
    );
    expect(deleted).toHaveLength(0);

    // The row survives — B could not see, let alone delete, A's session.
    const truth = await admin.query<{ n: string }>(
      'select count(*)::text as n from sessions where id = $1',
      [created!.id],
    );
    expect(truth.rows[0]?.n).toBe('1');
  });

  it('scopes device visibility to the owner', async () => {
    const aDevices = await withUserContext(handle, userA, (db) => db.select().from(devices));
    expect(aDevices).toHaveLength(1);

    const bDevices = await withUserContext(handle, userB, (db) => db.select().from(devices));
    expect(bDevices).toHaveLength(0);
  });

  it('lets a user read only their own identity row', async () => {
    const aSelf = await withUserContext(handle, userA, (db) => db.select().from(users));
    expect(aSelf).toHaveLength(1);
    expect(aSelf[0]?.id).toBe(userA);
  });

  it('denies the user-scoped role ALL access to the owner-only secret tables', async () => {
    // auth_sessions / oauth_tokens / push_subscriptions hold secrets the relay touches only on its
    // trusted owner path; telecode_app is granted nothing, so even a SELECT is a permission error
    // (deny-all). This guards the lockdown that keeps session tokens, GitHub tokens, and push endpoints
    // unreadable by the user-scoped RLS role. (Drizzle wraps the pg error, so we check the cause chain.)
    async function expectPermissionDenied(run: () => Promise<unknown>): Promise<void> {
      try {
        await run();
        throw new Error('expected a permission error, but the query succeeded');
      } catch (err) {
        // Drizzle wraps the pg error ("permission denied for table …") as the `cause`.
        const cause = (err as { cause?: unknown }).cause;
        const detail = `${(err as Error).message} ${cause instanceof Error ? cause.message : ''}`;
        expect(detail).toMatch(/permission denied/i);
      }
    }

    await expectPermissionDenied(() =>
      withUserContext(handle, userA, (db) => db.select().from(authSessions)),
    );
    await expectPermissionDenied(() =>
      withUserContext(handle, userA, (db) => db.select().from(oauthTokens)),
    );
    await expectPermissionDenied(() =>
      withUserContext(handle, userA, (db) => db.select().from(pushSubscriptions)),
    );
  });
});
