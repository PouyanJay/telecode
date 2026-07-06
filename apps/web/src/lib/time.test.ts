import { describe, expect, it } from 'vitest';

import { clockTime, relativeTime } from './time';

const NOW = new Date('2026-06-29T12:00:00Z').getTime();

describe('relativeTime', () => {
  it("reads the last few seconds as 'just now'", () => {
    expect(relativeTime(new Date(NOW - 20_000), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW), NOW)).toBe('just now');
  });

  it('reads minutes within the hour', () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000), NOW)).toBe('5 min ago');
    expect(relativeTime(new Date(NOW - 59 * 60_000), NOW)).toBe('59 min ago');
  });

  it('rolls up to hours, then days', () => {
    expect(relativeTime(new Date(NOW - 2 * 3_600_000), NOW)).toBe('2 hr ago');
    expect(relativeTime(new Date(NOW - 3 * 86_400_000), NOW)).toBe('3 d ago');
  });

  it('rounds at the unit boundaries (30s → minutes, 60min → hours, 24hr → days)', () => {
    expect(relativeTime(new Date(NOW - 30_000), NOW)).toBe('1 min ago');
    expect(relativeTime(new Date(NOW - 60 * 60_000), NOW)).toBe('1 hr ago');
    expect(relativeTime(new Date(NOW - 24 * 3_600_000), NOW)).toBe('1 d ago');
  });
});

describe('clockTime (segment crumb / lineage times, ux Phase 3)', () => {
  it('reads a same-day instant as a bare clock time', () => {
    expect(clockTime(new Date('2026-06-29T14:14:00Z'), NOW, 'UTC')).toBe('2:14 PM');
    expect(clockTime(new Date('2026-06-29T09:05:00Z'), NOW, 'UTC')).toBe('9:05 AM');
  });

  it('prefixes a short date once the instant is not today (an honest cross-day crumb)', () => {
    expect(clockTime(new Date('2026-06-27T14:14:00Z'), NOW, 'UTC')).toBe('Jun 27 · 2:14 PM');
  });

  it('judges "today" in the display timezone, not UTC', () => {
    // 23:30 UTC on the 28th is already the 29th in a UTC+2 zone — same day as NOW there.
    expect(clockTime(new Date('2026-06-28T23:30:00Z'), NOW, 'Europe/Berlin')).toBe('1:30 AM');
  });
});
