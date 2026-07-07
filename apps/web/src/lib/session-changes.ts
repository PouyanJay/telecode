import {
  sessionChangesPayloadSchema,
  type Envelope,
  type SessionChangesPayload,
} from '@telecode/protocol';

/**
 * Sealed branch-diff summaries (`session.changes`, branch-actions Phase C), web leg: live frames —
 * decrypted upstream by the relay client — fold into one map keyed by session id; the rail's CHANGES
 * panel reads it. Pure reducer (no store/DOM coupling), mirroring `session-meta.ts`.
 */
export type SessionChangesMap = ReadonlyMap<string, SessionChangesPayload>;

/**
 * Fold one live `session.changes` frame into the map. A frame REPLACES the session's snapshot —
 * unlike the merging meta map, a diff summary is whole, and merging two would fabricate a diff no
 * daemon ever reported. Ciphertext this browser held no key for (non-empty nonce, string payload)
 * and malformed payloads are skipped; the decrypted re-send arrives after key self-healing.
 */
export function applyChangesFrame(map: SessionChangesMap, envelope: Envelope): SessionChangesMap {
  const sessionId = envelope.session_id;
  if (sessionId === undefined || (envelope.nonce !== '' && typeof envelope.payload === 'string')) {
    return map;
  }
  const parsed = sessionChangesPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) return map;
  const next = new Map(map);
  next.set(sessionId, parsed.data);
  return next;
}
