import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  base64KeySchema,
  permissionModeSchema,
  sessionHistoryEntrySchema,
  sessionMetaPayloadSchema,
  sessionStatusSchema,
  type PermissionModeName,
  type SessionHistoryEntry,
  type SessionMetaPayload,
  type SessionStatusName,
} from '@telecode/protocol';
import { z } from 'zod';
import type { Logger } from 'pino';

/**
 * Durable, on-disk home for finished session transcripts (architecture invariant #7: "the session lives on
 * the laptop; reopen is a reconnect, not a restart"). The daemon holds each session's transcript in memory;
 * without this, a daemon restart loses every transcript, so a reopened-but-finished session backfills empty
 * and the UI goes blank. The store writes one JSON file per session under a daemon-local directory (the
 * user's own machine — the same trust boundary that already holds the worktrees and the repo's real code;
 * the relay never sees it, consistent with E2E). Files are written `0600` (owner-only).
 *
 * It is injected (composition root in `main.ts`); tests that don't exercise persistence omit it. The
 * factory and its two contract types (`PersistedSession`, `SessionStore`) are tightly-coupled siblings,
 * co-located here per the one-public-export "tightly-coupled siblings" exception.
 */
const persistedSessionSchema = z.object({
  status: sessionStatusSchema,
  permissionMode: permissionModeSchema,
  transcript: z.array(sessionHistoryEntrySchema),
  // The session's E2E content key (base64) — persisted so a restart re-establishes the SAME key
  // rather than rotating it, keeping any blob sealed under it (relay cache / Postgres) decryptable
  // (ux Phase 6 T3). Absent for a cleartext-mode daemon or a pre-T3 file.
  contentKey: base64KeySchema.optional(),
  // The last sealed metadata the daemon emitted (title/cwd/model/mode) — persisted so a restored
  // session re-emits its identity on subscribe instead of a bare UUID (ux Phase 6 T3).
  meta: sessionMetaPayloadSchema.optional(),
});

export interface PersistedSession {
  readonly status: SessionStatusName;
  readonly permissionMode: PermissionModeName;
  readonly transcript: SessionHistoryEntry[];
  readonly contentKey?: string | undefined;
  readonly meta?: SessionMetaPayload | undefined;
}

export interface SessionStore {
  /** Load every persisted session (validated at this trust boundary). Missing dir ⇒ empty map. */
  loadAll(): Promise<Map<string, PersistedSession>>;
  /** Persist a session's record. Coalesced + async (never blocks the daemon's hot path). */
  save(sessionId: string, record: PersistedSession): void;
}

/** A session id is the file name; require a real UUID so a crafted id can't escape the store directory. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSessionStore(options: { dir: string; logger?: Logger }): SessionStore {
  const { dir, logger } = options;

  // Per-session coalescing: keep only the latest snapshot to write, and at most one write in flight per
  // session. Rapid mutations during a run collapse into a single trailing write — no unbounded write storm.
  const latest = new Map<string, string>();
  const writing = new Set<string>();

  async function flush(sessionId: string): Promise<void> {
    writing.add(sessionId);
    try {
      await mkdir(dir, { recursive: true });
      let json = latest.get(sessionId);
      while (json !== undefined) {
        await writeFile(join(dir, `${sessionId}.json`), json, { mode: 0o600 });
        // Clear only the snapshot we just wrote; a newer save() during the write stays queued and the loop
        // writes it next. The delete is AFTER a successful write (not before) so a write error preserves the
        // snapshot — the next save() re-attempts it. Best-effort: a terminal session that never saves again
        // keeps its transcript only in this run's in-memory record if the write keeps failing.
        if (latest.get(sessionId) === json) latest.delete(sessionId);
        json = latest.get(sessionId);
      }
    } catch (err) {
      logger?.error({ err, sessionId }, 'session-store: failed to persist session transcript');
    } finally {
      writing.delete(sessionId);
    }
  }

  return {
    async loadAll(): Promise<Map<string, PersistedSession>> {
      const out = new Map<string, PersistedSession>();
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        return out; // directory doesn't exist yet — nothing persisted
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const sessionId = file.slice(0, -'.json'.length);
        if (!SESSION_ID_RE.test(sessionId)) continue;
        try {
          const raw = await readFile(join(dir, file), 'utf8');
          const parsed = persistedSessionSchema.safeParse(JSON.parse(raw));
          if (parsed.success) {
            out.set(sessionId, parsed.data);
          } else {
            logger?.warn({ sessionId }, 'session-store: discarding malformed session file');
          }
        } catch (err) {
          logger?.warn({ err, sessionId }, 'session-store: failed to read session file');
        }
      }
      return out;
    },

    save(sessionId: string, record: PersistedSession): void {
      if (!SESSION_ID_RE.test(sessionId)) return;
      latest.set(sessionId, JSON.stringify(record));
      if (!writing.has(sessionId)) void flush(sessionId);
    },
  };
}
