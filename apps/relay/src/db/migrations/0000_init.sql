CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_key" text,
	"device_token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"title" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"cwd" text,
	"permission_mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_provider_identity_unique" UNIQUE("provider","provider_user_id")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_id_idx" ON "sessions" USING btree ("device_id");--> statement-breakpoint
-- ============================================================================
-- Row Level Security, application role, and policies (HAND-AUTHORED — Drizzle
-- does not generate these; see SUPABASE.md). One logical change: lock down the
-- three registries created above.
--
-- We own auth (not Supabase Auth), so policies key on the per-transaction GUC
-- `telecode.user_id`, set by the relay via `SET LOCAL` (see withUserContext) —
-- NOT on auth.uid(), which is unset on our direct node-postgres connections.
-- User-scoped queries run as the non-superuser role `telecode_app` (SET LOCAL
-- ROLE), so RLS is actually enforced; trusted, server-derived paths use the
-- owner/superuser connection and bypass RLS by design.
--
-- Rollback: DROP POLICY <name> ON <table> for each policy below; ALTER TABLE
-- <table> NO FORCE / DISABLE ROW LEVEL SECURITY; REVOKE the grants; DROP ROLE
-- telecode_app; then DROP the three tables.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telecode_app') THEN
    -- NOINHERIT: privileges are used only via explicit `SET LOCAL ROLE telecode_app`, never inherited.
    CREATE ROLE telecode_app NOLOGIN NOINHERIT;
  END IF;
  -- Let the relay's login role assume telecode_app via SET ROLE. The Supabase `postgres` role
  -- has BYPASSRLS but is NOT a superuser, so it needs explicit membership; on a plain Postgres
  -- superuser this is a harmless no-op. The assumed role has no BYPASSRLS, so RLS still applies.
  -- NOTE: grant to the role NAME via format(%I) — `GRANT ... TO CURRENT_USER` (the keyword form)
  -- segfaults the PostgreSQL 17 backend.
  EXECUTE format('GRANT telecode_app TO %I', current_user);
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO telecode_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON public.users TO telecode_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.devices TO telecode_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO telecode_app;--> statement-breakpoint
-- Defense in depth: the Supabase API roles must never reach these tables (we
-- expose no PostgREST). Guarded so the migration stays portable to plain Postgres.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.users, public.devices, public.sessions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.users, public.devices, public.sessions FROM authenticated;
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.devices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- users: a user may read/update only their own identity row. Creation/deletion is
-- a trusted server-derived path (runs as owner, bypasses RLS) — no telecode_app policy.
CREATE POLICY "users_select_self" ON public.users
  FOR SELECT TO telecode_app
  USING (id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "users_update_self" ON public.users
  FOR UPDATE TO telecode_app
  USING (id = current_setting('telecode.user_id', true)::uuid)
  WITH CHECK (id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
-- devices: scoped to the owning user for every operation.
CREATE POLICY "devices_select_own" ON public.devices
  FOR SELECT TO telecode_app
  USING (user_id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "devices_insert_own" ON public.devices
  FOR INSERT TO telecode_app
  WITH CHECK (user_id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "devices_update_own" ON public.devices
  FOR UPDATE TO telecode_app
  USING (user_id = current_setting('telecode.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "devices_delete_own" ON public.devices
  FOR DELETE TO telecode_app
  USING (user_id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
-- sessions: scoped to the owning user for every operation.
CREATE POLICY "sessions_select_own" ON public.sessions
  FOR SELECT TO telecode_app
  USING (user_id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "sessions_insert_own" ON public.sessions
  FOR INSERT TO telecode_app
  WITH CHECK (user_id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "sessions_update_own" ON public.sessions
  FOR UPDATE TO telecode_app
  USING (user_id = current_setting('telecode.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('telecode.user_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "sessions_delete_own" ON public.sessions
  FOR DELETE TO telecode_app
  USING (user_id = current_setting('telecode.user_id', true)::uuid);
