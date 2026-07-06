import {
  sessionMetaPayloadSchema,
  type Envelope,
  type SessionMetaPayload,
} from '@telecode/protocol';

import type { RegistrySessionRow } from './session-groups';

/**
 * Sealed session metadata, web leg (ux Phase 6). Two sources feed one map keyed by session id:
 *  - live `session.meta` frames, decrypted upstream by the relay client (a frame that could NOT be
 *    decrypted still carries its string ciphertext payload — recognizably skipped here);
 *  - the registry's persisted `sealed_meta` blob on cold loads (cleartext-mode blobs decode directly;
 *    ciphertext blobs need the session content key, delivered live via subscribe today).
 * Pure reducers (no store/DOM coupling) so the merge is unit-testable; the session store wires them.
 */
export type SessionMetaMap = ReadonlyMap<string, SessionMetaPayload>;

/** Fold one live `session.meta` frame into the map (partial frames merge; invalid frames are ignored). */
export function applyMetaFrame(map: SessionMetaMap, envelope: Envelope): SessionMetaMap {
  const sessionId = envelope.session_id;
  // A non-empty nonce with a string payload is ciphertext the relay client held no key for — never
  // parse it as metadata (and never store it: the decrypted version arrives after key self-healing).
  if (sessionId === undefined || (envelope.nonce !== '' && typeof envelope.payload === 'string')) {
    return map;
  }
  const parsed = sessionMetaPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) return map;
  const next = new Map(map);
  next.set(sessionId, { ...map.get(sessionId), ...parsed.data });
  return next;
}

/**
 * Seed the map from the registry's persisted blobs (cold load). Live meta always wins — a frame that
 * arrived this visit is newer than anything the page load carried. Only cleartext blobs (empty nonce)
 * decode here; ciphertext blobs are skipped until this browser holds the session key.
 */
export function seedRegistryMetas(
  map: SessionMetaMap,
  rows: readonly RegistrySessionRow[],
): SessionMetaMap {
  let next: Map<string, SessionMetaPayload> | null = null;
  for (const row of rows) {
    if (map.has(row.id) || row.sealedMeta === null || row.sealedMetaNonce !== '') continue;
    const meta = decodeCleartextMeta(row.sealedMeta);
    if (meta === undefined) continue;
    next ??= new Map(map);
    next.set(row.id, meta);
  }
  return next ?? map;
}

/** Parse a cleartext (pre-E2E daemon) registry blob; `undefined` for malformed JSON or schema drift. */
function decodeCleartextMeta(blob: string): SessionMetaPayload | undefined {
  try {
    const parsed = sessionMetaPayloadSchema.safeParse(JSON.parse(blob));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
