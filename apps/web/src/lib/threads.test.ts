import { describe, expect, it } from 'vitest';

import type { SessionRow } from './session-groups';
import { lineageOf } from './lineage';
import { buildThreadRows, segmentLabel, type ThreadRow } from './threads';

/**
 * Threads (ux Phase 3, B1): sessions linked by `parentSessionId` collapse into ONE dashboard row — the
 * thread — keyed by the LEAF session (where the conversation lives now) and carrying its live status.
 * The chain renders as a segment crumb (terminal → telecode hops). Pure collapse over the already-merged
 * SessionRows; nothing is ever lost — every input session is either a thread row or one of its segments.
 */
const T0 = new Date('2026-07-05T14:14:00Z'); // the adopted terminal segment began
const T1 = new Date('2026-07-05T16:02:00Z'); // taken over into telecode
const T2 = new Date('2026-07-05T17:30:00Z'); // a second hop

function row(overrides: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    title: null,
    status: 'done',
    deviceId: 'dev-1',
    deviceName: 'macbook',
    origin: 'launched',
    isContinuation: false,
    parentSessionId: null,
    createdAt: T0,
    ...overrides,
  };
}

describe('buildThreadRows', () => {
  it('collapses a parent→child chain into one row keyed by the leaf, with root→leaf segments', () => {
    const parent = row({
      id: 'a',
      origin: 'external',
      title: 'fix pairing race',
      status: 'done',
      createdAt: T0,
    });
    const child = row({
      id: 'b',
      parentSessionId: 'a',
      isContinuation: true,
      status: 'running',
      createdAt: T1,
    });
    const threads = buildThreadRows([parent, child]);

    expect(threads).toHaveLength(1);
    const thread = threads[0] as ThreadRow;
    // The row IS the leaf: it links where the conversation lives now and carries its live status.
    expect(thread.id).toBe('b');
    expect(thread.status).toBe('running');
    // The conversation's identity is stable across a takeover: the root names it and dates it.
    expect(thread.origin).toBe('external');
    expect(thread.title).toBe('fix pairing race');
    expect(thread.segments.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(thread.segments.map((s) => s.origin)).toEqual(['external', 'launched']);
    expect(thread.segments.map((s) => s.startedAt)).toEqual([T0, T1]);
    expect(thread.segments.map((s) => s.isCurrent)).toEqual([false, true]);
  });

  it('collapses an N-hop chain in order and keeps only the leaf as a row', () => {
    const a = row({ id: 'a', origin: 'external', createdAt: T0 });
    const b = row({ id: 'b', parentSessionId: 'a', createdAt: T1 });
    const c = row({ id: 'c', parentSessionId: 'b', status: 'awaiting_input', createdAt: T2 });
    const threads = buildThreadRows([c, a, b]); // input order must not matter

    expect(threads.map((t) => t.id)).toEqual(['c']);
    expect(threads[0]?.segments.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
    expect(threads[0]?.status).toBe('awaiting_input');
  });

  it('passes unchained sessions through with no segments (the crumb is for chains only)', () => {
    const plain = row({ id: 'solo', status: 'running' });
    const adopted = row({ id: 'ext', origin: 'external' });
    const threads = buildThreadRows([plain, adopted]);

    expect(threads.map((t) => t.id).sort()).toEqual(['ext', 'solo']);
    for (const t of threads) expect(t.segments).toEqual([]);
  });

  it('treats a child whose parent row is unknown as unchained (no invented segment times)', () => {
    const orphan = row({ id: 'x', parentSessionId: 'gone', isContinuation: true });
    const threads = buildThreadRows([orphan]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.segments).toEqual([]);
    // The continuation fact is preserved — the row can still show its pill.
    expect(threads[0]?.isContinuation).toBe(true);
  });

  it('falls back down the chain for a title when the root has none', () => {
    const parent = row({ id: 'a', origin: 'external', title: null, createdAt: T0 });
    const child = row({
      id: 'b',
      parentSessionId: 'a',
      title: 'Continuing: apply?',
      createdAt: T1,
    });
    expect(buildThreadRows([parent, child])[0]?.title).toBe('Continuing: apply?');
  });

  it('a parent with two children yields two threads sharing the parent segment', () => {
    const parent = row({ id: 'a', origin: 'external', createdAt: T0 });
    const c1 = row({ id: 'b1', parentSessionId: 'a', createdAt: T1 });
    const c2 = row({ id: 'b2', parentSessionId: 'a', createdAt: T2 });
    const threads = buildThreadRows([parent, c1, c2]);

    expect(threads.map((t) => t.id).sort()).toEqual(['b1', 'b2']);
    for (const t of threads) {
      expect(t.segments[0]?.sessionId).toBe('a');
    }
  });

  it('never loses a session: a parent-link cycle degrades to plain rows, not an infinite loop', () => {
    const a = row({ id: 'a', parentSessionId: 'b' });
    const b = row({ id: 'b', parentSessionId: 'a' });
    const threads = buildThreadRows([a, b]);

    expect(threads.map((t) => t.id).sort()).toEqual(['a', 'b']);
    for (const t of threads) expect(t.segments).toEqual([]);
  });

  it('covers every input session exactly once across rows and segments', () => {
    const rows = [
      row({ id: 'a', origin: 'external', createdAt: T0 }),
      row({ id: 'b', parentSessionId: 'a', createdAt: T1 }),
      row({ id: 'solo' }),
      row({ id: 'orphan', parentSessionId: 'missing' }),
    ];
    const threads = buildThreadRows(rows);
    const seen = threads.flatMap((t) =>
      t.segments.length > 0 ? t.segments.map((s) => s.sessionId) : [t.id],
    );
    expect(seen.sort()).toEqual(['a', 'b', 'orphan', 'solo']);
  });
});

describe('segmentLabel', () => {
  it('names where a segment ran in the product vocabulary', () => {
    expect(segmentLabel('external')).toBe('terminal');
    expect(segmentLabel('launched')).toBe('telecode');
  });
});

describe('lineageOf (session-view lineage strip, B2)', () => {
  const member = (
    id: string,
    parentSessionId: string | null,
    origin: 'external' | 'launched',
    createdAt: Date,
  ) => ({ id, parentSessionId, origin, createdAt });

  it('returns the full root→leaf chain with the OPEN session marked current', () => {
    const members = [
      member('a', null, 'external', T0),
      member('b', 'a', 'launched', T1),
      member('c', 'b', 'launched', T2),
    ];
    // Opening the MIDDLE segment still shows the whole conversation, current = b.
    const segments = lineageOf('b', members);
    expect(segments.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
    expect(segments.map((s) => s.isCurrent)).toEqual([false, true, false]);
    expect(segments.map((s) => s.origin)).toEqual(['external', 'launched', 'launched']);
    expect(segments.map((s) => s.startedAt)).toEqual([T0, T1, T2]);
  });

  it('walks down through the NEWEST child when a segment was taken over twice', () => {
    const members = [
      member('a', null, 'external', T0),
      member('b-old', 'a', 'launched', T1),
      member('b-new', 'a', 'launched', T2),
    ];
    expect(lineageOf('a', members).map((s) => s.sessionId)).toEqual(['a', 'b-new']);
  });

  it('returns no lineage for an unchained session or an unknown id', () => {
    expect(lineageOf('solo', [member('solo', null, 'launched', T0)])).toEqual([]);
    expect(lineageOf('missing', [member('solo', null, 'launched', T0)])).toEqual([]);
  });

  it('stops at an unknown parent and guards against cycles', () => {
    const orphan = [member('x', 'gone', 'launched', T1)];
    expect(lineageOf('x', orphan)).toEqual([]);
    const cycle = [member('a', 'b', 'launched', T0), member('b', 'a', 'launched', T1)];
    // A cycle cannot render an honest linear strip — degrade to none rather than loop or lie.
    expect(lineageOf('a', cycle)).toEqual([]);
  });
});

describe('threads over the live overlay (a fresh fork before the registry catches up)', () => {
  it('collapses a registry parent with a child known only from a live session.chained frame', () => {
    const registryParent = row({
      id: 'parent',
      origin: 'external',
      title: 'Fix the pairing bug',
      status: 'done',
      createdAt: T0,
    });
    // What buildSessionRows produces for a live-only child whose session.chained just arrived.
    const liveChild = row({
      id: 'child',
      parentSessionId: 'parent',
      isContinuation: true,
      status: 'running',
      createdAt: T1,
    });
    const threads = buildThreadRows([registryParent, liveChild]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe('child');
    expect(threads[0]?.title).toBe('Fix the pairing bug');
    expect(threads[0]?.segments.map((s) => s.sessionId)).toEqual(['parent', 'child']);
  });
});
