import { z } from 'zod';

import type { SessionPageCursor } from './session-registry';

/**
 * The wire form of the session-list pagination cursor (ux Phase 6 T7): base64url JSON naming where the
 * previous page stopped, plus the VIEW it was minted for (`ended` | `archived`) so a cursor from one
 * view fails closed (400) instead of silently paginating the other from a skewed offset. OPAQUE to
 * clients — they echo it verbatim; only the relay mints and reads it. Validated on decode (zod at the
 * trust boundary): garbage → null → the route 400s. Encode/decode co-located: two halves of one wire
 * format that can only change together.
 */
export type SessionCursorScope = 'ended' | 'archived';

export interface DecodedSessionCursor {
  readonly cursor: SessionPageCursor;
  readonly scope: SessionCursorScope;
}

const cursorSchema = z.object({
  u: z.string().datetime(),
  id: z.string().uuid(),
  s: z.enum(['ended', 'archived']),
});

export function encodeSessionCursor(cursor: SessionPageCursor, scope: SessionCursorScope): string {
  return Buffer.from(
    JSON.stringify({ u: cursor.updatedAt.toISOString(), id: cursor.id, s: scope }),
    'utf8',
  ).toString('base64url');
}

export function decodeSessionCursor(wire: string): DecodedSessionCursor | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(Buffer.from(wire, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = cursorSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return {
    cursor: { updatedAt: new Date(parsed.data.u), id: parsed.data.id },
    scope: parsed.data.s,
  };
}
