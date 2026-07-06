import type { SessionOrigin } from '@telecode/protocol';

import type { SessionRow } from './session-groups';

/**
 * Threads (ux Phase 3, B1): sessions linked by `parentSessionId` collapse into ONE dashboard row — the
 * display unit becomes the conversation, not its hops. The row is keyed by the LEAF session (where the
 * conversation lives now) and carries the leaf's live status, so taking a session over no longer reads
 * as its death ("parent card suddenly DONE"). The chain renders as a segment crumb; unchained sessions
 * pass through untouched (`segments: []`) and keep today's pills. Pure collapse over the already-merged
 * {@link SessionRow}s so every consumer (dashboard, tallies) shares one truth.
 */
export interface ThreadSegment {
  readonly sessionId: string;
  /** Where this stretch ran: adopted from the user's own terminal/IDE, or launched in telecode. */
  readonly origin: SessionOrigin;
  /** When this stretch began (its session's registry creation time). */
  readonly startedAt: Date;
  /** The segment the conversation lives in now (the leaf) — the crumb's amber tick. */
  readonly isCurrent: boolean;
}

/**
 * One dashboard thread. `id`/`status`/`deviceName`/`createdAt` are the LEAF's (the row links to and
 * sorts by where the conversation is now); `origin`/`title` are the ROOT's (the conversation's stable
 * identity — a takeover must not rename the row), with the title falling down the chain when the root
 * has none. `segments` is root→leaf for a chain of 2+ known sessions, empty for an unchained session.
 */
export interface ThreadRow extends SessionRow {
  readonly segments: readonly ThreadSegment[];
}

function segmentFor(row: SessionRow, leafId: string): ThreadSegment {
  return {
    sessionId: row.id,
    origin: row.origin,
    startedAt: row.createdAt,
    isCurrent: row.id === leafId,
  };
}

/**
 * The chain root→leaf for a leaf row, following `parentSessionId` upward. Stops at an unknown parent
 * (never invents a segment for a session we can't see) and guards against link cycles. A chain shorter
 * than 2 collapses to nothing — the caller renders the row unchained.
 */
function chainFor(leaf: SessionRow, byId: ReadonlyMap<string, SessionRow>): SessionRow[] {
  const chain: SessionRow[] = [leaf];
  const visited = new Set<string>([leaf.id]);
  let parentId = leaf.parentSessionId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (!parent || visited.has(parent.id)) break;
    chain.push(parent);
    visited.add(parent.id);
    parentId = parent.parentSessionId;
  }
  return chain.reverse();
}

/**
 * Collapse merged session rows into thread rows. Total: every input session appears exactly once —
 * as a thread row or inside one's segments. A session that would vanish (a parent-link cycle has no
 * leaf) degrades to a plain unchained row instead; honesty beats prettiness.
 */
export function buildThreadRows(rows: readonly SessionRow[]): ThreadRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const hasChild = new Set<string>();
  for (const row of rows) {
    if (row.parentSessionId !== null && byId.has(row.parentSessionId)) {
      hasChild.add(row.parentSessionId);
    }
  }

  const threads: ThreadRow[] = [];
  const absorbed = new Set<string>();
  for (const leaf of rows) {
    if (hasChild.has(leaf.id)) continue; // not a leaf — it lives inside a descendant's thread
    const chain = chainFor(leaf, byId);
    if (chain.length < 2) {
      threads.push({ ...leaf, segments: [] });
      continue;
    }
    const root = chain[0] as SessionRow;
    for (const member of chain) absorbed.add(member.id);
    threads.push({
      ...leaf,
      origin: root.origin,
      title: chain.map((row) => row.title).find((title) => title !== null) ?? null,
      segments: chain.map((row) => segmentFor(row, leaf.id)),
    });
  }
  // A cycle has no leaf, so its members were skipped AND never absorbed — surface them as plain rows.
  for (const row of rows) {
    if (hasChild.has(row.id) && !absorbed.has(row.id)) {
      threads.push({ ...row, segments: [] });
    }
  }
  return threads;
}

/** Where a segment ran, in the product vocabulary (the crumb's words). */
export function segmentLabel(origin: SessionOrigin): 'terminal' | 'telecode' {
  return origin === 'external' ? 'terminal' : 'telecode';
}
