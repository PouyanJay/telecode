import { SESSION_STATUSES } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { composerModeFor } from './composer-mode';

/**
 * The composer's single decision point (adopted-takeover T4/T5): what does typing into this session
 * DO right now? Exhaustive over every status × origin so a NEW status must consciously pick a mode —
 * the silent-spinner composer (the user's report) is exactly what an unhandled case regresses to.
 */
describe('composerModeFor', () => {
  it('routes an adopted between-turns session to the one-step takeover', () => {
    expect(composerModeFor('waiting_local', 'external')).toBe('takeover');
  });

  it('keeps ended/needs_restart sessions on resume-as-new (unchanged behavior)', () => {
    expect(composerModeFor('needs_restart', 'launched')).toBe('resume_new');
    expect(composerModeFor('needs_restart', 'external')).toBe('resume_new');
    expect(composerModeFor('done', 'external')).toBe('resume_new');
    expect(composerModeFor('error', 'external')).toBe('resume_new');
    expect(composerModeFor('turn_limit', 'external')).toBe('resume_new');
  });

  it('blocks with an honest reason while an adopted session is mid-turn locally', () => {
    expect(composerModeFor('running', 'external')).toBe('blocked_local_turn');
    expect(composerModeFor('starting', 'external')).toBe('blocked_local_turn');
  });

  it('covers every status × origin — no case may fall to a silent disabled composer', () => {
    const expected: Record<
      (typeof SESSION_STATUSES)[number],
      { launched: string; external: string }
    > = {
      starting: { launched: 'follow_up', external: 'blocked_local_turn' },
      running: { launched: 'follow_up', external: 'blocked_local_turn' },
      // Gates carry their own in-transcript affordances (approve/answer/handover cards).
      awaiting_input: { launched: 'follow_up', external: 'follow_up' },
      // Ended LAUNCHED sessions keep their in-place resume (existing composer follow-up).
      done: { launched: 'follow_up', external: 'resume_new' },
      error: { launched: 'follow_up', external: 'resume_new' },
      turn_limit: { launched: 'follow_up', external: 'resume_new' },
      needs_restart: { launched: 'resume_new', external: 'resume_new' },
      offline_paused: { launched: 'follow_up', external: 'follow_up' },
      waiting_local: { launched: 'follow_up', external: 'takeover' },
    };
    for (const status of SESSION_STATUSES) {
      expect(composerModeFor(status, 'launched'), `${status} launched`).toBe(
        expected[status].launched,
      );
      expect(composerModeFor(status, 'external'), `${status} external`).toBe(
        expected[status].external,
      );
    }
  });

  it('treats an unknown status (no registry row yet) as a plain follow-up', () => {
    expect(composerModeFor(undefined, 'launched')).toBe('follow_up');
    expect(composerModeFor('idle', 'launched')).toBe('follow_up');
  });
});
