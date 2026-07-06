-- Session housekeeping (ux Phase 6 T7). `archived_at` is the soft, reversible shelf: a TERMINAL session
-- the user archived is hidden from the default dashboard list but kept (with its sealed metadata) for the
-- archived view; unarchive clears it. The composite index serves the new list ordering (last activity,
-- `updated_at` desc) AND the keyset pagination cursor `(updated_at, id)` in one structure. To reverse:
-- drop the index then the column.
ALTER TABLE "sessions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sessions_user_activity_idx" ON "sessions" USING btree ("user_id", "updated_at" DESC, "id" DESC);
