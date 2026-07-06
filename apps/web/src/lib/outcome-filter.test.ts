import { describe, expect, it } from 'vitest';

import {
  buildOutcomeChips,
  filterRowsByOutcome,
  outcomeBoardHref,
  outcomeFilterFromSearch,
} from './outcome-filter';
import type { SessionRow } from './session-groups';
import type { SessionStatus } from './session';

/**
 * Outcome chips on the board's ended group (mockup §01-7): scope the Recent list to one ending.
 * URL-carried (`?outcome=`) like the device filter, composing with it.
 */
function row(id: string, status: SessionStatus): SessionRow {
  return {
    id,
    title: id,
    status,
    deviceId: 'd1',
    deviceName: null,
    origin: 'launched',
    isContinuation: false,
    parentSessionId: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    lastActivityAt: new Date('2026-07-01T00:00:00Z'),
  };
}

describe('buildOutcomeChips', () => {
  it('builds the All chip plus one chip per ENDING present, in the canonical order', () => {
    const chips = buildOutcomeChips([
      row('a', 'done'),
      row('b', 'needs_restart'),
      row('c', 'done'),
      row('d', 'error'),
      row('e', 'offline_paused'), // not an ending — counts toward All only
    ]);
    expect(chips).toEqual([
      { outcome: null, label: 'ALL', count: 5 },
      { outcome: 'done', label: 'COMPLETED', count: 2 },
      { outcome: 'error', label: 'FAILED', count: 1 },
      { outcome: 'needs_restart', label: 'NEEDS RESTART', count: 1 },
    ]);
  });

  it('omits chips for endings with no rows (never a zero-count chip)', () => {
    const chips = buildOutcomeChips([row('a', 'turn_limit')]);
    expect(chips.map((c) => c.outcome)).toEqual([null, 'turn_limit']);
  });
});

describe('filterRowsByOutcome', () => {
  const rows = [row('a', 'done'), row('b', 'error'), row('c', 'idle')];

  it('null keeps every row (the unfiltered group)', () => {
    expect(filterRowsByOutcome(rows, null).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('an outcome keeps only rows that ended that way (non-ended recents hide)', () => {
    expect(filterRowsByOutcome(rows, 'done').map((r) => r.id)).toEqual(['a']);
    expect(filterRowsByOutcome(rows, 'error').map((r) => r.id)).toEqual(['b']);
  });
});

describe('outcomeFilterFromSearch', () => {
  it('accepts only real endings; garbage or absence degrades to the unfiltered group', () => {
    expect(outcomeFilterFromSearch(new URLSearchParams('outcome=done'))).toBe('done');
    expect(outcomeFilterFromSearch(new URLSearchParams('outcome=needs_restart'))).toBe(
      'needs_restart',
    );
    expect(outcomeFilterFromSearch(new URLSearchParams('outcome=running'))).toBeNull();
    expect(outcomeFilterFromSearch(new URLSearchParams('outcome=nonsense'))).toBeNull();
    expect(outcomeFilterFromSearch(new URLSearchParams(''))).toBeNull();
  });
});

describe('outcomeBoardHref', () => {
  it('sets or clears ?outcome= while PRESERVING the device scope (the two filters compose)', () => {
    expect(outcomeBoardHref('done', new URLSearchParams(''))).toBe('/?outcome=done');
    expect(outcomeBoardHref(null, new URLSearchParams('outcome=done'))).toBe('/');
    expect(outcomeBoardHref('error', new URLSearchParams('device=d1'))).toBe(
      '/?device=d1&outcome=error',
    );
    expect(outcomeBoardHref(null, new URLSearchParams('device=d1&outcome=error'))).toBe(
      '/?device=d1',
    );
  });
});
