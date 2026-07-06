import type { SessionOrigin } from '@telecode/protocol';

import { type ThreadSegment } from './threads';

/** The chain facts `lineageOf` needs — structural, so registry rows and merged rows both fit. */
export interface LineageMember {
  readonly id: string;
  readonly parentSessionId: string | null;
  readonly origin: SessionOrigin;
  readonly createdAt: Date;
}

/**
 * The whole conversation a session belongs to, root→end, for the session view's lineage strip (B2) —
 * `isCurrent` marks the OPEN session, wherever it sits in the chain (a reopened parent still shows the
 * strip). Walks up through `parentSessionId`, then down through each segment's NEWEST child (a segment
 * taken over twice continues through the take that stuck). Unknown parents, unknown ids, cycles, and
 * unchained sessions all yield `[]` — the strip renders only an honest, linear chain.
 */
/** Ancestors of `open`, nearest-first. `null` when the links form a cycle (no honest linear chain). */
function walkUpward(
  open: LineageMember,
  byId: ReadonlyMap<string, LineageMember>,
  visited: Set<string>,
): LineageMember[] | null {
  const upward: LineageMember[] = [];
  let parentId = open.parentSessionId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (!parent) break; // unknown parent — never invent a segment
    if (visited.has(parent.id)) return null;
    upward.push(parent);
    visited.add(parent.id);
    parentId = parent.parentSessionId;
  }
  return upward;
}

/** Descendants of `open`, following each segment's NEWEST child (the take that stuck). */
function walkDownward(
  open: LineageMember,
  members: readonly LineageMember[],
  visited: Set<string>,
): LineageMember[] {
  const newestChildOf = new Map<string, LineageMember>();
  for (const m of members) {
    if (m.parentSessionId === null) continue;
    const best = newestChildOf.get(m.parentSessionId);
    if (!best || m.createdAt.getTime() > best.createdAt.getTime()) {
      newestChildOf.set(m.parentSessionId, m);
    }
  }
  const downward: LineageMember[] = [];
  let tip = open;
  for (;;) {
    const child = newestChildOf.get(tip.id);
    // The visited check is a termination backstop, not a reachable branch today: each member has ONE
    // parent link, so any cycle reachable from `open` is caught by walkUpward first. It stays because
    // this unbounded loop must terminate even on registry data that breaks that invariant.
    if (!child || visited.has(child.id)) break;
    downward.push(child);
    visited.add(child.id);
    tip = child;
  }
  return downward;
}

export function lineageOf(sessionId: string, members: readonly LineageMember[]): ThreadSegment[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const open = byId.get(sessionId);
  if (!open) return [];

  const visited = new Set<string>([open.id]);
  const upward = walkUpward(open, byId, visited);
  if (upward === null) return []; // a link cycle can't render an honest linear strip
  const downward = walkDownward(open, members, visited);

  const chain = [...upward.reverse(), open, ...downward];
  if (chain.length < 2) return [];
  return chain.map((m) => ({
    sessionId: m.id,
    origin: m.origin,
    startedAt: m.createdAt,
    isCurrent: m.id === open.id,
  }));
}
