import { SESSION_ORIGINS, SESSION_STATUSES } from '@telecode/protocol';
import { z } from 'zod';

import type { RegistrySessionRow } from './session-groups';

/**
 * Housekeeping client helpers (ux Phase 6 T7): fetch one more page of ended (or archived) sessions from
 * the session-list BFF and merge it under the rows a page already holds. Pure logic + fetch — the board
 * and the archived view drive their "Load more" through these.
 */

/** One archived/ended row as the page renders it: registry shape + when it ended/was shelved. */
export interface SessionPageRow extends RegistrySessionRow {
  readonly endedAt: Date | null;
  readonly archivedAt: Date | null;
}

export interface SessionPageResult {
  readonly rows: SessionPageRow[];
  readonly nextCursor: string | null;
}

/** The BFF's page body — validated at this boundary (enums rebuilt from the protocol tuples). */
const pageBodySchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      deviceId: z.string(),
      title: z.string().nullable(),
      status: z.enum(SESSION_STATUSES),
      origin: z.enum(SESSION_ORIGINS),
      parentSessionId: z.string().nullable(),
      sealedMeta: z.string().nullable(),
      sealedMetaNonce: z.string().nullable(),
      sealedTitle: z.string().nullable(),
      sealedTitleNonce: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      endedAt: z.string().nullable(),
      archivedAt: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

/**
 * Fetch the next session page from the BFF (`cursor` from the previous page; `archived` flips to the
 * archived view). Returns null on any failure — the caller keeps what it has and surfaces a retry.
 */
export async function fetchSessionPage(input: {
  cursor: string;
  archived?: boolean;
}): Promise<SessionPageResult | null> {
  const params = new URLSearchParams({ cursor: input.cursor });
  if (input.archived) params.set('archived', 'true');
  try {
    const res = await fetch(`/api/sessions?${params.toString()}`);
    if (!res.ok) return null;
    const parsed = pageBodySchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return {
      rows: parsed.data.sessions.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
        endedAt: row.endedAt ? new Date(row.endedAt) : null,
        archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
      })),
      nextCursor: parsed.data.nextCursor,
    };
  } catch {
    return null;
  }
}

/**
 * Merge a fetched page under the rows already loaded, never duplicating an id (the already-loaded copy
 * wins — it may carry live overlay state; a re-fetched duplicate is at best identical).
 */
export function appendSessionRows<Row extends RegistrySessionRow>(
  existing: readonly Row[],
  incoming: readonly Row[],
): Row[] {
  const known = new Set(existing.map((row) => row.id));
  return [...existing, ...incoming.filter((row) => !known.has(row.id))];
}
