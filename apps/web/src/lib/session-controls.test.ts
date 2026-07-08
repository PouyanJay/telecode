import { describe, expect, it } from 'vitest';

import { sessionControlsFor } from './session-controls';

/**
 * Honest operator controls (adopted-takeover T6): an adopted session never shows Interrupt (there is
 * no telecode-owned turn to abort — the old button silently did nothing), and its End reads "Stop
 * following" (it retires the mirror; the local process is untouched). Launched sessions unchanged.
 */
describe('sessionControlsFor', () => {
  it('keeps the launched controls exactly as they were', () => {
    expect(sessionControlsFor('launched', true, false)).toEqual({
      showInterrupt: true,
      showEnd: true,
      endLabel: 'End',
    });
    expect(sessionControlsFor('launched', false, false)).toEqual({
      showInterrupt: false,
      showEnd: true,
      endLabel: 'End',
    });
  });

  it('never offers Interrupt for an adopted session — even mid-turn', () => {
    expect(sessionControlsFor('external', true, false).showInterrupt).toBe(false);
    expect(sessionControlsFor('external', false, false).showInterrupt).toBe(false);
  });

  it('relabels End to "Stop following" for adopted sessions, with the honest elaboration', () => {
    const controls = sessionControlsFor('external', true, false);
    expect(controls.showEnd).toBe(true);
    expect(controls.endLabel).toBe('Stop following');
    expect(controls.endTitle).toMatch(/local process is untouched/);
  });

  it('offers no End once the session is terminal (any origin)', () => {
    expect(sessionControlsFor('launched', false, true).showEnd).toBe(false);
    expect(sessionControlsFor('external', false, true).showEnd).toBe(false);
  });
});
