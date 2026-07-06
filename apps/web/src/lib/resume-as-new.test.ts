import { describe, expect, it } from 'vitest';

import { canResumeAsNew } from './resume-as-new';

/**
 * The resume-as-new gate (ux Phase 6 T8): exactly the sessions that CANNOT continue in place.
 */
describe('canResumeAsNew', () => {
  it('offers it for needs_restart regardless of origin (the conversation is lost)', () => {
    expect(canResumeAsNew('needs_restart', 'launched')).toBe(true);
    expect(canResumeAsNew('needs_restart', 'external')).toBe(true);
  });

  it('offers it for every ENDED adopted session (nothing to follow up in place)', () => {
    expect(canResumeAsNew('done', 'external')).toBe(true);
    expect(canResumeAsNew('error', 'external')).toBe(true);
    expect(canResumeAsNew('turn_limit', 'external')).toBe(true);
  });

  it('never offers it where the composer already continues in place (ended launched sessions)', () => {
    expect(canResumeAsNew('done', 'launched')).toBe(false);
    expect(canResumeAsNew('error', 'launched')).toBe(false);
    expect(canResumeAsNew('turn_limit', 'launched')).toBe(false);
  });

  it.each(['running', 'starting', 'awaiting_input', 'offline_paused', 'idle'] as const)(
    'never offers it on a %s session (either origin)',
    (status) => {
      expect(canResumeAsNew(status, 'launched')).toBe(false);
      expect(canResumeAsNew(status, 'external')).toBe(false);
    },
  );
});
