import { describe, expect, it } from 'vitest';

import { deviceChannelOf, deviceStatus } from './devices';

const NOW = new Date('2026-06-29T12:00:00Z').getTime();

/**
 * Per-device presence (ux Phase 5): every paired device has its OWN channel, so status inputs are
 * that device's channel state + the REST `online` snapshot from page load. Priority: live channel
 * presence (daemon frames) > REST snapshot > honest unknown. The old single-watched-device rule
 * ("only devices[0] can be online") is gone.
 */
describe('deviceStatus', () => {
  it('reports online when the daemon is present on the device’s own live channel', () => {
    const status = deviceStatus(
      { lastSeenAt: new Date(NOW), connection: 'connected', daemonOnline: true, restOnline: null },
      NOW,
    );
    expect(status).toEqual({ tone: 'success', label: 'ONLINE', online: true, lastSeen: 'now' });
  });

  it('reports OFFLINE when the live channel says the daemon is gone — snapshot cannot override', () => {
    // The frame is newer than the page-load snapshot: live truth wins.
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 10 * 60_000),
        connection: 'connected',
        daemonOnline: false,
        restOnline: true,
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

  it('renders the REST snapshot before the channel is up — a cold load knows who is online', () => {
    // SSR window: effects haven't dialed yet (idle channel), but the relay's snapshot said the
    // daemon is on its channel. This is the whole point of the snapshot (plan Part C Phase 5).
    const status = deviceStatus(
      { lastSeenAt: new Date(NOW), connection: 'idle', daemonOnline: null, restOnline: true },
      NOW,
    );
    expect(status.online).toBe(true);
    expect(status.label).toBe('ONLINE');
  });

  it('renders the snapshot while the channel is still dialing', () => {
    const online = deviceStatus(
      { lastSeenAt: new Date(NOW), connection: 'connecting', daemonOnline: null, restOnline: true },
      NOW,
    );
    expect(online.label).toBe('ONLINE');

    const offline = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 3_600_000),
        connection: 'connecting',
        daemonOnline: null,
        restOnline: false,
      },
      NOW,
    );
    expect(offline.label).toBe('OFFLINE');
    expect(offline.lastSeen).toBe('1 hr ago');
  });

  it('shows connecting when nothing is known yet (no live frame, no snapshot — old-relay skew)', () => {
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 2 * 3_600_000),
        connection: 'connecting',
        daemonOnline: null,
        restOnline: null,
      },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('CONNECTING…');
    expect(status.lastSeen).toBe('2 hr ago');
  });

  it('an authenticated channel still awaiting its first presence frame (no snapshot) stays connecting', () => {
    // The relay sends a presence snapshot right after hello.ack, so this window is milliseconds —
    // but it must read as "unknown, still confirming", never as a claim either way.
    const status = deviceStatus(
      { lastSeenAt: new Date(NOW), connection: 'connected', daemonOnline: null, restOnline: null },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('CONNECTING…');
  });

  it('reports offline on a connection error, whatever any earlier signal said', () => {
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 60_000),
        connection: 'error',
        daemonOnline: true,
        restOnline: true,
      },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('OFFLINE');
  });

  it('a stale live claim does not survive a redial — mid-reconnect falls back to the snapshot', () => {
    // The socket died and is redialing: the last presence frame (online) predates the drop, so it
    // is no longer a live claim. The snapshot (false here) is the best remaining truth.
    const status = deviceStatus(
      {
        lastSeenAt: new Date(NOW - 60_000),
        connection: 'connecting',
        daemonOnline: true,
        restOnline: false,
      },
      NOW,
    );
    expect(status.online).toBe(false);
    expect(status.label).toBe('OFFLINE');
  });

  it("reads a never-seen offline device's last-seen as 'never'", () => {
    const status = deviceStatus(
      { lastSeenAt: null, connection: 'idle', daemonOnline: null, restOnline: false },
      NOW,
    );
    expect(status.lastSeen).toBe('never');
    expect(status.online).toBe(false);
  });
});

describe('deviceChannelOf', () => {
  it('returns the device’s channel state, or the idle default when it is not pooled yet', () => {
    const channels = new Map([['dev-a', { connection: 'connected' as const, daemonOnline: true }]]);
    expect(deviceChannelOf(channels, 'dev-a')).toEqual({
      connection: 'connected',
      daemonOnline: true,
    });
    expect(deviceChannelOf(channels, 'dev-b')).toEqual({ connection: 'idle', daemonOnline: null });
  });
});
