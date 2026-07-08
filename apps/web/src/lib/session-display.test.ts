import { describe, expect, it } from 'vitest';

import { SESSION_DISPLAY } from './session-display';

/**
 * Status vocabulary: labels say what is happening in the operator's words. `idle` reads IDLE (not the
 * jargon-y READY — honesty pass T8), `offline_paused` reads PAUSED · OFFLINE so "OFFLINE" alone never
 * means two different things, and every ENDING reads as WHAT happened (status split, ux Phase 6 T2,
 * plan B5) — never one lump "DONE".
 */
describe('SESSION_DISPLAY vocabulary', () => {
  it('labels an idle session IDLE', () => {
    expect(SESSION_DISPLAY.idle.label).toBe('IDLE');
  });

  it('labels an offline-paused session PAUSED · OFFLINE (distinct from device presence)', () => {
    expect(SESSION_DISPLAY.offline_paused.label).toBe('PAUSED · OFFLINE');
    expect(SESSION_DISPLAY.offline_paused.tone).toBe('warning');
  });

  it('keeps the live "needs you / working" statuses on the accent with a pulse', () => {
    for (const status of ['running', 'awaiting_input'] as const) {
      expect(SESSION_DISPLAY[status].tone).toBe('accent');
      expect(SESSION_DISPLAY[status].pulse).toBe(true);
    }
  });

  it('reads an adopted between-turns session as AT YOUR TERMINAL, calm by design', () => {
    // adopted-takeover T1: nothing is executing and nothing needs the operator NOW — muted, no
    // pulse. Amber stays reserved for the live/needs-you states above.
    expect(SESSION_DISPLAY.waiting_local).toEqual({
      tone: 'muted',
      label: 'AT YOUR TERMINAL',
      pulse: false,
    });
  });

  it('no two statuses share a label (every state is distinguishable at a glance)', () => {
    const labels = Object.values(SESSION_DISPLAY).map((display) => display.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('SESSION_DISPLAY status split (ux Phase 6 T2)', () => {
  it('names the four endings distinctly', () => {
    expect(SESSION_DISPLAY.done.label).toBe('COMPLETED');
    expect(SESSION_DISPLAY.error.label).toBe('FAILED');
    expect(SESSION_DISPLAY.turn_limit.label).toBe('ENDED · TURN LIMIT');
    expect(SESSION_DISPLAY.needs_restart.label).toBe('NEEDS RESTART');
  });

  it('tones endings by meaning: success, danger, and warning for the recoverable states', () => {
    expect(SESSION_DISPLAY.done.tone).toBe('success');
    expect(SESSION_DISPLAY.error.tone).toBe('danger');
    expect(SESSION_DISPLAY.turn_limit.tone).toBe('warning');
    expect(SESSION_DISPLAY.needs_restart.tone).toBe('warning');
  });

  it('never pulses a terminal state', () => {
    for (const status of ['done', 'error', 'turn_limit', 'needs_restart'] as const) {
      expect(SESSION_DISPLAY[status].pulse).toBe(false);
    }
  });
});
