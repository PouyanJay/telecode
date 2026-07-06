-- Defense in depth for the opaque sealed_meta blob (ux Phase 6): the relay already drops oversized
-- session.meta frames before writing, but the DB enforces the same ceiling so no other write path can
-- bloat rows the relay cannot read. Bounds match MAX_SEALED_META_CHARS / MAX_SEALED_META_NONCE_CHARS
-- in apps/relay/src/relay.ts. To reverse: drop the two constraints.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_sealed_meta_len" CHECK (char_length("sealed_meta") <= 8192);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_sealed_meta_nonce_len" CHECK (char_length("sealed_meta_nonce") <= 64);
