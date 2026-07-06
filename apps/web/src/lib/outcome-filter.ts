import {
  SESSION_END_STATUSES,
  isSessionEndStatus,
  type SessionEndedPayload,
} from '@telecode/protocol';

import { SESSION_DISPLAY } from './session-display';
import type { SessionRow } from './session-groups';

/**
 * Outcome chips + the ended group's filter (mockup §01-7): the Recent list scopes to one ENDING via
 * `?outcome=<status>` — URL-carried like the device filter (`?device=`), and composing with it, so a
 * reload or a shared link keeps both scopes. Pure logic; the dashboard renders it.
 */
export type OutcomeKey = SessionEndedPayload['status'];

export interface OutcomeChip {
  /** The ending this chip scopes to; null = the "All" chip. */
  readonly outcome: OutcomeKey | null;
  /** The house status label (COMPLETED / FAILED / …) — one vocabulary everywhere. */
  readonly label: string;
  readonly count: number;
}

/**
 * The All chip plus one chip per ending PRESENT in the group (never a zero-count chip), in the
 * protocol's canonical order. Callers typically render the row only when 2+ endings coexist —
 * a single-outcome group has nothing to scope.
 */
export function buildOutcomeChips(rows: readonly SessionRow[]): OutcomeChip[] {
  const counts = new Map<OutcomeKey, number>();
  for (const row of rows) {
    if (isSessionEndStatus(row.status)) {
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    }
  }
  const chips: OutcomeChip[] = [{ outcome: null, label: 'ALL', count: rows.length }];
  for (const outcome of SESSION_END_STATUSES) {
    const count = counts.get(outcome);
    if (count !== undefined) {
      chips.push({ outcome, label: SESSION_DISPLAY[outcome].label, count });
    }
  }
  return chips;
}

/** Whether the chips are worth a row: 2+ endings coexist (one ALL chip + one chip per ending). */
export function hasMultipleOutcomes(chips: readonly OutcomeChip[]): boolean {
  return chips.length >= 3;
}

/** Scope rows to one ending (null = all). Non-ended recents (paused/idle) show only unfiltered. */
export function filterRowsByOutcome<Row extends { readonly status: string }>(
  rows: readonly Row[],
  outcome: OutcomeKey | null,
): Row[] {
  if (outcome === null) return [...rows];
  return rows.filter((row) => row.status === outcome);
}

/** The active outcome filter from the URL; anything but a real ending degrades to unfiltered. */
export function outcomeFilterFromSearch(search: URLSearchParams): OutcomeKey | null {
  const wanted = search.get('outcome');
  return wanted !== null && isSessionEndStatus(wanted) ? wanted : null;
}

/** The board's href for an outcome scope, preserving every other filter (the device scope). */
export function outcomeBoardHref(outcome: OutcomeKey | null, search: URLSearchParams): string {
  const params = new URLSearchParams(search);
  if (outcome === null) params.delete('outcome');
  else params.set('outcome', outcome);
  const query = params.toString();
  return query === '' ? '/' : `/?${query}`;
}
