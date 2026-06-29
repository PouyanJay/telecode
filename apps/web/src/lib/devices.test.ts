import { describe, expect, it } from 'vitest';

import { deviceStatus } from './devices';

const NOW = new Date('2026-06-29T12:00:00Z').getTime();

describe('deviceStatus', () => {
  it('reports the watched device online only while the connection is up', () => {
    const status = deviceStatus(
      { lastSeenAt: new Date(NOW), isWatched: true, connection: 'connected' },
      NOW,
    );
    expect(status).toEqual({ tone: 'success', label: 'ONLINE', online: true, lastSeen: 'now' });
  });

  it('shows the watched device as connecting before the channel is up', () => {
    const status = deviceStatus(
      { lastSeenAt: new Date(NOW - 2 * 3_600_000), isWatched: true, connection: 'connecting' },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('CONNECTING…');
    expect(status.lastSeen).toBe('2 hr ago');
  });

  it('reports the watched device offline when the channel drops (idle/error)', () => {
    const status = deviceStatus(
      { lastSeenAt: new Date(NOW - 5 * 60_000), isWatched: true, connection: 'idle' },
      NOW,
    );
    expect(status).toEqual({
      tone: 'muted',
      label: 'OFFLINE',
      online: false,
      lastSeen: '5 min ago',
    });
  });

  it('reports any non-watched device offline with its last-seen time (no live signal to guess from)', () => {
    const status = deviceStatus(
      { lastSeenAt: new Date(NOW - 2 * 3_600_000), isWatched: false, connection: 'connected' },
      NOW,
    );
    expect(status).toEqual({
      tone: 'muted',
      label: 'OFFLINE',
      online: false,
      lastSeen: '2 hr ago',
    });
  });

  it("reads a never-seen device's last-seen as 'never'", () => {
    const status = deviceStatus({ lastSeenAt: null, isWatched: false, connection: 'idle' }, NOW);
    expect(status.lastSeen).toBe('never');
    expect(status.online).toBe(false);
  });
});
