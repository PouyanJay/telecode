-- Defense-in-depth for the archive shelf (ux Phase 6 T7, security review): archived ⇒ terminal, at
-- the database. Application paths already keep this true (archive/delete are terminal-only guarded
-- updates; a resumed session clears archived_at in the same UPDATE that flips its status), but a bug
-- anywhere must not be able to mint a row that is both live and shelved — it would show on the board
-- AND in the archived view at once. Mirrors the 0008 pattern (CHECK backstop after 0007's column).
-- To reverse: drop the constraint.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_archived_terminal" CHECK ("archived_at" IS NULL OR "status" IN ('done', 'error', 'turn_limit', 'needs_restart'));
