CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
-- ============================================================================
-- RLS lockdown for auth_sessions (HAND-AUTHORED — Drizzle does not emit this).
-- Browser login sessions are touched only on the trusted relay auth path (owner
-- connection, which has BYPASSRLS), never by the user-scoped telecode_app role.
-- So: RLS is ENABLED + FORCED with NO policy → telecode_app is denied all access;
-- the Supabase API roles (anon/authenticated) are revoked for defense in depth.
-- Rollback: ALTER TABLE auth_sessions DISABLE ROW LEVEL SECURITY; DROP TABLE auth_sessions.
-- ============================================================================
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.auth_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Make the deny-all explicit: telecode_app is never granted access to auth_sessions (owner-path only).
REVOKE ALL ON public.auth_sessions FROM telecode_app;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.auth_sessions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.auth_sessions FROM authenticated;
  END IF;
END
$$;