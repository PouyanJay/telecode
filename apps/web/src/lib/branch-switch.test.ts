import { SESSION_STATUSES } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { canSwitchBranch } from './branch-switch';

/**
 * The switch offer's session-shape gate (branch-actions T4): launched + settled-but-followable
 * only. Exhaustive over every status so a NEW status must consciously pick a side here.
 */
describe('canSwitchBranch', () => {
  it('offers the switch only between turns of a launched session', () => {
    const expected: Record<(typeof SESSION_STATUSES)[number], boolean> = {
      starting: false,
      running: false,
      awaiting_input: false, // a live gate is mid-turn
      done: true,
      error: false, // no follow-up would continue it — nothing to switch for
      offline_paused: false,
      turn_limit: true, // settled but followable
      needs_restart: false,
      waiting_local: false, // adopted-only state; a launched session can never be in it
    };
    for (const status of SESSION_STATUSES) {
      expect(canSwitchBranch(status, 'launched'), status).toBe(expected[status]);
    }
  });

  it('never offers it for adopted sessions (display-only by design) or unknown status', () => {
    for (const status of SESSION_STATUSES) {
      expect(canSwitchBranch(status, 'external'), status).toBe(false);
    }
    expect(canSwitchBranch(undefined, 'launched')).toBe(false);
  });
});
