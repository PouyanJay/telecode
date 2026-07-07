import { SESSION_STATUSES } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { canPushBranch } from './push-offer';

/**
 * The push offer's session-shape gate (branch-actions T6): launched + branch known + settled.
 * Exhaustive over every status so a NEW status must consciously pick a side here.
 */
describe('canPushBranch', () => {
  it('offers the push for every settled state of a launched session with a branch', () => {
    const expected: Record<(typeof SESSION_STATUSES)[number], boolean> = {
      starting: false,
      running: false,
      awaiting_input: false, // a live gate is mid-turn
      done: true,
      error: true, // stranded work is exactly what wants rescuing into a PR
      offline_paused: false, // the device cannot act anyway
      turn_limit: true,
      needs_restart: true,
    };
    for (const status of SESSION_STATUSES) {
      expect(canPushBranch(status, 'launched', 'feat/x'), status).toBe(expected[status]);
    }
  });

  it('never offers it without a branch, for adopted sessions, or for an unknown status', () => {
    expect(canPushBranch('done', 'launched', undefined)).toBe(false);
    for (const status of SESSION_STATUSES) {
      expect(canPushBranch(status, 'external', 'feat/x'), status).toBe(false);
    }
    expect(canPushBranch(undefined, 'launched', 'feat/x')).toBe(false);
  });
});
