CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
-- ============================================================================
-- RLS lockdown for push_subscriptions (HAND-AUTHORED — Drizzle does not emit this).
-- Web-push subscriptions are touched only on the trusted relay path (owner connection,
-- which has BYPASSRLS) — to send a notification when a session needs input — never by
-- the user-scoped telecode_app role and never read by the browser. So, like auth_sessions:
-- RLS is ENABLED + FORCED with NO policy → telecode_app is denied all access; the Supabase
-- API roles (anon/authenticated) are revoked too.
-- Rollback: ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY; DROP TABLE push_subscriptions.
-- ============================================================================
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.push_subscriptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.push_subscriptions FROM telecode_app;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.push_subscriptions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.push_subscriptions FROM authenticated;
  END IF;
END
$$;