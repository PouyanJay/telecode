import { drizzle } from 'drizzle-orm/node-postgres';

import { type Database, type DbHandle } from './client';
import * as schema from './schema';

/**
 * Run `fn` inside a transaction bound to the authenticated user, so Row Level Security enforces
 * per-user isolation. Two things make RLS actually apply:
 *
 *  1. `SET LOCAL ROLE telecode_app` drops from the connection's (super)user login role to the
 *     non-superuser app role that policies are written `TO` — superusers bypass RLS, this role does not.
 *  2. `set_config('telecode.user_id', <uuid>, true)` sets the per-transaction GUC the policies read
 *     (`current_setting('telecode.user_id', true)::uuid`). `set_config` is used instead of `SET` so the
 *     value is bound as a parameter, never string-interpolated.
 *
 * Both are transaction-local, so they reset when the pooled connection is returned — no leakage between
 * requests. Trusted, server-derived paths (user upsert at OAuth time, daemon-routed writes) deliberately
 * skip this helper and use the owner connection, which bypasses RLS.
 */
export async function withUserContext<T>(
  handle: DbHandle,
  userId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const client = await handle.pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role telecode_app');
    await client.query("select set_config('telecode.user_id', $1, true)", [userId]);
    const scoped = drizzle(client, { schema });
    const result = await fn(scoped);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
