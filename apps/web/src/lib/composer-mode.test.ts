import { SESSION_STATUSES } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import {
  composerDisabledReasonFor,
  composerModeFor,
  composerPlaceholderFor,
} from './composer-mode';

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

  // Exhaustive status × origin coverage — each case reports independently (it.each), and a NEW
  // status is caught by the derived cases: a missing key here is a type error via the Record.
  const MODE_MATRIX: Record<
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
  it.each(SESSION_STATUSES)('%s picks a conscious mode for both origins', (status) => {
    expect(composerModeFor(status, 'launched'), `${status} launched`).toBe(
      MODE_MATRIX[status].launched,
    );
    expect(composerModeFor(status, 'external'), `${status} external`).toBe(
      MODE_MATRIX[status].external,
    );
  });

  it('treats an unknown status (no registry row yet) as a plain follow-up', () => {
    expect(composerModeFor(undefined, 'launched')).toBe('follow_up');
    expect(composerModeFor('idle', 'launched')).toBe('follow_up');
  });
});

describe('composer copy helpers (one voice per mode)', () => {
  it('gives each mode its placeholder', () => {
    expect(composerPlaceholderFor('follow_up')).toBe('Send a follow-up instruction…');
    expect(composerPlaceholderFor('takeover')).toBe('Send your next task — it continues here…');
    expect(composerPlaceholderFor('resume_new')).toBe('Continue this work in a new session…');
    expect(composerPlaceholderFor('blocked_local_turn')).toBe('Send a follow-up instruction…');
  });

  it('blocks with the honest local-turn reason, and only then', () => {
    expect(composerDisabledReasonFor('blocked_local_turn', true)).toMatch(
      /working in your terminal/,
    );
    expect(composerDisabledReasonFor('follow_up', true)).toBeUndefined();
    expect(composerDisabledReasonFor('takeover', true)).toBeUndefined();
  });

  it('blocks a resume-as-new fork on an invalid branch name — the typed message is preserved', () => {
    expect(composerDisabledReasonFor('resume_new', false)).toMatch(/valid git branch name/);
    expect(composerDisabledReasonFor('resume_new', true)).toBeUndefined();
    // An invalid branch matters only where a fork is offered — never blocks other modes.
    expect(composerDisabledReasonFor('follow_up', false)).toBeUndefined();
    expect(composerDisabledReasonFor('takeover', false)).toBeUndefined();
  });
});
