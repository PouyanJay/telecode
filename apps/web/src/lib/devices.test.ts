import { describe, expect, it } from 'vitest';

import { deviceStatus } from './devices';

const NOW = new Date('2026-06-29T12:00:00Z').getTime();

describe('deviceStatus', () => {
  it('reports the watched device online only when the daemon itself is present on the channel', () => {
    const status = deviceStatus(
      { lastSeenAt: new Date(NOW), isWatched: true, connection: 'connected', daemonOnline: true },
      NOW,
    );
    expect(status).toEqual({ tone: 'success', label: 'ONLINE', online: true, lastSeen: 'now' });
  });

  it('reports the watched device OFFLINE when the browser channel is up but the daemon is not (honesty)', () => {
    // The old logic claimed "online · now" from the browser's own socket alone — a dead daemon read as
    // online while its sessions showed paused. The daemon's device.presence is the truth signal.
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 10 * 60_000),
        isWatched: true,
        connection: 'connected',
        daemonOnline: false,
      },
      NOW,
    );
    expect(status).toEqual({
      tone: 'muted',
      label: 'OFFLINE',
      online: false,
      lastSeen: '10 min ago',
    });
  });

  it('shows connecting while the presence snapshot has not arrived yet (daemonOnline unknown)', () => {
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 2 * 3_600_000),
        isWatched: true,
        connection: 'connected',
        daemonOnline: null,
      },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('CONNECTING…');
    expect(status.lastSeen).toBe('2 hr ago');
  });

  it('shows the watched device as connecting before the channel is up', () => {
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 2 * 3_600_000),
        isWatched: true,
        connection: 'connecting',
        daemonOnline: null,
      },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('CONNECTING…');
    expect(status.lastSeen).toBe('2 hr ago');
  });

  it('reports the watched device offline when the channel drops (idle/error), whatever presence said last', () => {
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 5 * 60_000),
        isWatched: true,
        connection: 'idle',
        daemonOnline: true,
      },
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
      {
        lastSeenAt: new Date(NOW - 2 * 3_600_000),
        isWatched: false,
        connection: 'connected',
        daemonOnline: true,
      },
      NOW,
    );
    expect(status).toEqual({
      tone: 'muted',
      label: 'OFFLINE',
      online: false,
      lastSeen: '2 hr ago',
    });
  });

  it('reports offline on a connection error, whatever presence said last', () => {
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 60_000),
        isWatched: true,
        connection: 'error',
        daemonOnline: true,
      },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('OFFLINE');
  });

  it('stays connecting mid-reconnect even when the last presence frame said online', () => {
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 60_000),
        isWatched: true,
        connection: 'connecting',
        daemonOnline: true,
      },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('CONNECTING…');
  });

  it("reads a never-seen device's last-seen as 'never'", () => {
    const status = deviceStatus(
      { lastSeenAt: null, isWatched: false, connection: 'idle', daemonOnline: null },
      NOW,
    );
    expect(status.lastSeen).toBe('never');
    expect(status.online).toBe(false);
  });
});
