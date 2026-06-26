import { describe, expect, it, vi } from 'vitest';

import { createTelemetry, type TelemetryEvent } from '../src/telemetry';

/**
 * Telemetry seam (Phase 5 Task 4). telecode collects nothing by default — privacy is the product. This
 * proves the stance is enforced in code: the default telemetry is a no-op (an operator must explicitly
 * opt in), an opted-in instance routes events to its *own* injected sink (never a network destination
 * wired in this codebase), and the seam never throws into the caller's hot path.
 */
describe('telemetry seam (opt-in, no-op by default)', () => {
  const event: TelemetryEvent = { name: 'peer_connected', role: 'browser' };

  it('records nothing when telemetry is not enabled (the default)', () => {
    const sink = vi.fn();
    const telemetry = createTelemetry({ sink });

    telemetry.record(event);

    expect(sink).not.toHaveBeenCalled();
  });

  it('routes events to the injected sink when explicitly enabled', () => {
    const sink = vi.fn();
    const telemetry = createTelemetry({ enabled: true, sink });

    telemetry.record(event);

    expect(sink).toHaveBeenCalledWith(event);
  });

  it('never lets a failing sink throw into the caller', () => {
    const telemetry = createTelemetry({
      enabled: true,
      sink: () => {
        throw new Error('sink exploded');
      },
    });

    expect(() => telemetry.record(event)).not.toThrow();
  });
});
