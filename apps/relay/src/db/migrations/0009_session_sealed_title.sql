-- Session rename override (ux Phase 6 T6): the user's title, kept in a blob SEPARATE from sealed_meta so
-- a later daemon-derived title can never clobber a rename (the browser merges override-wins). Sealed under
-- the per-session content key — OPAQUE to the relay (invariant #5), stored only so a cold load can hand it
-- back. A RESET-to-derived clears both columns. Bounds match sealed_meta (MAX_SEALED_META_CHARS /
-- MAX_SEALED_META_NONCE_CHARS in apps/relay/src/relay.ts). To reverse: drop the two constraints then the
-- two columns.
ALTER TABLE "sessions" ADD COLUMN "sealed_title" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sealed_title_nonce" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_sealed_title_len" CHECK (char_length("sealed_title") <= 8192);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_sealed_title_nonce_len" CHECK (char_length("sealed_title_nonce") <= 64);
