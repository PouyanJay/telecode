import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config for the relay's registries. `generate` emits structural DDL into
 * `src/db/migrations`; the RLS / role / policy blocks are hand-authored into each generated migration
 * (Drizzle does not emit them — see SUPABASE.md). Migrations are applied by {@link runMigrations}
 * (`src/db/migrate.ts`), not by `drizzle-kit migrate`, so they run identically against the Supabase
 * local stack (dev) and a plain Postgres container (CI).
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
