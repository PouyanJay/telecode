import { sessionTitlePayloadSchema, type Envelope } from '@telecode/protocol';

import type { SealedMetaDecryptor } from './session-meta';
import type { RegistrySessionRow } from './session-groups';

/**
 * The user's session-title OVERRIDE, web leg (ux Phase 6 T6). Kept in a map SEPARATE from the daemon-owned
 * `session.meta` (see `session-meta.ts`) so the two never race: on display the override wins, so a later
 * derived title from the daemon can never clobber a rename. Two sources feed one map keyed by session id:
 *  - live `session.title` frames (decrypted upstream by the relay client): a SET carries `{ title }`, a
 *    RESET carries the cleartext `{ reset: true }` marker;
 *  - the registry's persisted `sealed_title` blob on cold loads (cleartext blobs decode directly;
 *    ciphertext blobs need this browser's persisted per-session content key, exactly like sealed_meta).
 * Pure reducers (no store/DOM coupling) so the merge is unit-testable; the session store wires them.
 */
export type SessionTitleMap = ReadonlyMap<string, string>;

/**
 * Fold one live `session.title` frame into the override map. A SET (`{ title }`) sets the override; a
 * RESET (`{ reset: true }`) clears it. Undecryptable ciphertext (a non-empty nonce with a still-string
 * payload — the relay client held no key) is ignored, never stored as a raw blob. Invalid frames are
 * ignored too.
 */
export function applyTitleFrame(map: SessionTitleMap, envelope: Envelope): SessionTitleMap {
  const sessionId = envelope.session_id;
  if (sessionId === undefined || (envelope.nonce !== '' && typeof envelope.payload === 'string')) {
    return map;
  }
  const parsed = sessionTitlePayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) return map;
  const next = new Map(map);
  if ('reset' in parsed.data) next.delete(sessionId);
  else next.set(sessionId, parsed.data.title);
  return next;
}

/**
 * Seed the override map from the registry's persisted CLEARTEXT `sealed_title` blobs (cold load) — the
 * pre-E2E-daemon path, an empty nonce. Ciphertext blobs are decoded by {@link seedRegistryTitlesAsync}.
 * Live overrides always win: an id the map already holds is left untouched.
 */
export function seedRegistryTitles(
  map: SessionTitleMap,
  rows: readonly RegistrySessionRow[],
): SessionTitleMap {
  let next: Map<string, string> | null = null;
  for (const row of rows) {
    if (map.has(row.id) || row.sealedTitle === null || row.sealedTitleNonce !== '') continue;
    const title = decodeCleartextTitle(row.sealedTitle);
    if (title === undefined) continue;
    next ??= new Map(map);
    next.set(row.id, title);
  }
  return next ?? map;
}

/** Parse a cleartext (pre-E2E daemon) rename blob into its title; `undefined` for malformed JSON/schema. */
function decodeCleartextTitle(blob: string): string | undefined {
  try {
    const parsed = sessionTitlePayloadSchema.safeParse(JSON.parse(blob));
    return parsed.success && 'title' in parsed.data ? parsed.data.title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The cold-load seed WITH content-key durability (ux Phase 6 T6, mirroring the sealed_meta path): cleartext
 * blobs decode synchronously (as {@link seedRegistryTitles}), and CIPHERTEXT blobs are decrypted via
 * `decrypt` — backed by this browser's persisted per-session content keys — so a rename survives a reload
 * even with no daemon and no relay cache. A blob this browser holds no key for is simply skipped. Live
 * overrides always win.
 */
export async function seedRegistryTitlesAsync(
  map: SessionTitleMap,
  rows: readonly RegistrySessionRow[],
  decrypt: SealedMetaDecryptor,
): Promise<SessionTitleMap> {
  const base = seedRegistryTitles(map, rows);
  let next: Map<string, string> | null = null;
  await Promise.all(
    rows.map(async (row) => {
      if (
        map.has(row.id) ||
        row.sealedTitle === null ||
        row.sealedTitleNonce === null ||
        row.sealedTitleNonce === '' // cleartext handled by the sync seed above
      ) {
        return;
      }
      const opened = await decrypt(row.id, row.sealedTitle, row.sealedTitleNonce);
      if (opened === null) return;
      const parsed = sessionTitlePayloadSchema.safeParse(opened);
      if (!parsed.success || !('title' in parsed.data)) return;
      next ??= new Map(base);
      next.set(row.id, parsed.data.title);
    }),
  );
  return next ?? base;
}

/** Add only the decrypted overrides whose ids the live map doesn't already hold (a live frame wins). */
export function overlayMissingTitles(
  live: SessionTitleMap,
  decrypted: SessionTitleMap,
): SessionTitleMap {
  let merged: Map<string, string> | null = null;
  for (const [id, title] of decrypted) {
    if (live.has(id)) continue;
    merged ??= new Map(live);
    merged.set(id, title);
  }
  return merged ?? live;
}
