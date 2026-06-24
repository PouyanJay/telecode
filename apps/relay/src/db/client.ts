import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { type Logger } from 'pino';

import * as schema from './schema';

/**
 * Typed Drizzle handle over a node-postgres pool. The relay is the sole DB-access layer (the web tier
 * delegates persistence to it over HTTP — see SUPABASE.md / AD-1). Queries issued directly on `db` run
 * as the connection's login role; user-scoped, RLS-checked queries must go through {@link withUserContext}.
 */
export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Database;
  readonly pool: Pool;
  /** Close the pool. Idempotent per pool; call on shutdown. */
  close(): Promise<void>;
}

/** Open a pooled Drizzle handle for `connectionString`. The caller owns its lifecycle via {@link DbHandle.close}. */
export function createDb(connectionString: string, logger?: Logger): DbHandle {
  const pool = new Pool({ connectionString });
  // Idle-client errors (e.g. the backend dropping a pooled connection) are re-emitted by pg as 'error'
  // on the pool; without a listener they crash the process. The pool reconnects transparently.
  pool.on('error', (err) => logger?.warn({ err }, 'db: idle pool client error'));
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
