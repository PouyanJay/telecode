import { describe, expect, it } from 'vitest';

import { SESSION_DISPLAY } from './session-display';

/**
 * Status vocabulary (honesty pass T8): labels say what is happening in the operator's words. `idle`
 * reads IDLE (not the jargon-y READY), and `offline_paused` reads PAUSED · OFFLINE so "OFFLINE" alone
 * never means two different things (device presence vs. a paused session).
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

  it('no two statuses share a label (every state is distinguishable at a glance)', () => {
    const labels = Object.values(SESSION_DISPLAY).map((display) => display.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
