import { describe, expect, it } from 'vitest';

import { resolvePlaceholder } from './session-placeholder';

/**
 * The session view's pre-transcript placeholder (ux Phase 5): the infinite "RECONNECTING…" is
 * replaced by a decision table that names the actual blocker — relay down, device revoked, device
 * offline (with its name, plan B5), or a healthy restore with an honest not-responding escalation.
 */
const base = {
  relayState: 'connected' as const,
  deviceName: 'mini-server' as string | null,
  deviceRevoked: false,
  deviceOnline: true,
  timedOut: false,
};

describe('resolvePlaceholder', () => {
  it('reports the relay link itself when the browser cannot reach it', () => {
    const p = resolvePlaceholder({ ...base, relayState: 'error' });
    expect(p.eyebrow).toBe('RELAY OFFLINE');
    expect(p.message).toMatch(/channel is offline/i);
  });

  it('says connecting while the relay link is still coming up — no device claims yet', () => {
    expect(resolvePlaceholder({ ...base, relayState: 'connecting' }).eyebrow).toBe('CONNECTING…');
    expect(resolvePlaceholder({ ...base, relayState: 'idle' }).eyebrow).toBe('CONNECTING…');
  });

  it('names a revoked device instead of spinning forever', () => {
    const p = resolvePlaceholder({
      ...base,
      deviceRevoked: true,
      deviceName: null,
      deviceOnline: false,
    });
    expect(p.eyebrow).toBe('DEVICE REVOKED');
    expect(p.message).toMatch(/revoked/i);
  });

  it("names the offline device: 'runs on <name>, which isn't connected' (plan B5)", () => {
    const p = resolvePlaceholder({ ...base, deviceOnline: false });
    expect(p.eyebrow).toBe('DEVICE OFFLINE');
    expect(p.message).toContain('mini-server');
    expect(p.message).toMatch(/isn’t connected/);
  });

  it('explains an offline device even when its name is unknown', () => {
    const p = resolvePlaceholder({ ...base, deviceOnline: false, deviceName: null });
    expect(p.eyebrow).toBe('DEVICE OFFLINE');
    expect(p.message).toMatch(/device isn’t connected/i);
  });

  it('shows the healthy restoring state while the device is online and fresh', () => {
    const p = resolvePlaceholder(base);
    expect(p.eyebrow).toBe('RESTORING…');
    expect(p.message).toMatch(/restoring/i);
  });

  it('escalates honestly when an online device never returns the transcript', () => {
    const p = resolvePlaceholder({ ...base, timedOut: true });
    expect(p.eyebrow).toBe('NOT RESPONDING');
    expect(p.message).toContain('mini-server');
  });

  it('escalation without a device name stays generic but honest', () => {
    const p = resolvePlaceholder({ ...base, timedOut: true, deviceName: null });
    expect(p.eyebrow).toBe('NOT RESPONDING');
    expect(p.message).toMatch(/device is connected but/i);
  });

  it('a revoked device wins over other device facts (most specific truth first)', () => {
    const p = resolvePlaceholder({ ...base, deviceRevoked: true, deviceOnline: false });
    expect(p.eyebrow).toBe('DEVICE REVOKED');
  });
});
