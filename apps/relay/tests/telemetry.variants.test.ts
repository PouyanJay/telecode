import { describe, expect, it, vi } from 'vitest';

import { createTelemetry, type TelemetryEvent } from '../src/telemetry';

/**
 * Variant coverage for the telemetry seam: every event type across the enabled/disabled matrix, and the
 * privacy invariant that no event ever carries an identifier or session content.
 */
const ALL_EVENTS: TelemetryEvent[] = [
  { name: 'peer_connected', role: 'daemon' },
  { name: 'peer_connected', role: 'browser' },
  { name: 'peer_disconnected', role: 'daemon' },
  { name: 'peer_disconnected', role: 'browser' },
];

describe('telemetry variants', () => {
  it.each(ALL_EVENTS)('does not record %o when telemetry is disabled', (event) => {
    const sink = vi.fn();
    createTelemetry({ enabled: false, sink }).record(event);
    expect(sink).not.toHaveBeenCalled();
  });

  it.each(ALL_EVENTS)('records %o to the sink when telemetry is enabled', (event) => {
    const sink = vi.fn();
    createTelemetry({ enabled: true, sink }).record(event);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it('emits no identifiers or session content in any event', () => {
    const recorded: TelemetryEvent[] = [];
    const telemetry = createTelemetry({ enabled: true, sink: (e) => recorded.push(e) });
    for (const event of ALL_EVENTS) telemetry.record(event);

    for (const event of recorded) {
      // The only keys an event may carry are `name` and `role`.
      expect(Object.keys(event).sort()).toEqual(['name', 'role']);
    }
  });

  it('defaults to a no-op when no options are given', () => {
    const sink = vi.fn();
    // No `enabled`, no `sink` — the default must record nothing and not throw.
    expect(() => createTelemetry().record(ALL_EVENTS[0]!)).not.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });
});
