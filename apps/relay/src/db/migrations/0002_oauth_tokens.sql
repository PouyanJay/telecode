CREATE TABLE "oauth_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"access_token_cipher" text NOT NULL,
	"access_token_nonce" text NOT NULL,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ============================================================================
-- RLS lockdown for oauth_tokens (HAND-AUTHORED — Drizzle does not emit this).
-- The user's OAuth access token (encrypted at rest) is touched only on the trusted
-- relay path (owner connection, which has BYPASSRLS) — to list repos on the user's
-- behalf — never by the user-scoped telecode_app role and never by the browser.
-- So, like auth_sessions: RLS is ENABLED + FORCED with NO policy → telecode_app is
-- denied all access; the Supabase API roles (anon/authenticated) are revoked too.
-- Rollback: ALTER TABLE oauth_tokens DISABLE ROW LEVEL SECURITY; DROP TABLE oauth_tokens.
-- ============================================================================
ALTER TABLE public.oauth_tokens ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.oauth_tokens FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Make the deny-all explicit: telecode_app is never granted access to oauth_tokens (owner-path only).
REVOKE ALL ON public.oauth_tokens FROM telecode_app;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.oauth_tokens FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.oauth_tokens FROM authenticated;
  END IF;
END
$$;