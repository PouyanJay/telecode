import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Daemon relay-link liveness. The daemon dials *out* to the relay; if that TCP path goes HALF-OPEN (laptop
 * sleep, NAT rebind, a firewall silently dropping the flow) the ws `close` event never fires, so the
 * `close`-only reconnect path is blind to it — the daemon keeps sending frames into a dead socket forever
 * and the relay marks the device offline. The daemon must probe the link itself (mirror of the relay's own
 * Phase-4 heartbeat): ping on an interval, and if a round goes unanswered, terminate the half-open socket
 * so its `close` fires and the daemon reconnects.
 *
 * Driven through the real fake-relay WS: silence the server socket (no pong, no close) and assert the
 * daemon re-registers on its own — proof its watchdog, not any server-side close, recovered the link.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

/**
 * Resolve `'reconnected'` if the daemon re-registers within `windowMs`, else `'stable'`. Lets a test assert
 * the NEGATIVE — that no reconnect happened over a span of several heartbeat intervals — without hanging.
 */
async function reconnectedWithin(
  relay: FakeRelay,
  windowMs: number,
): Promise<'reconnected' | 'stable'> {
  return Promise.race<'reconnected' | 'stable'>([
    relay.waitForHello().then(() => 'reconnected' as const),
    new Promise<'stable'>((resolve) => setTimeout(() => resolve('stable'), windowMs)),
  ]);
}

describe('daemon: relay heartbeat (half-open detection)', () => {
  it('reconnects when the link goes half-open and no close ever fires', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: createFakeAgentAdapter([]),
      logger: silent,
      reconnect: { baseMs: 10, maxMs: 40 },
      // Fast heartbeat so the watchdog sweep runs within the test.
      heartbeat: { intervalMs: 30 },
    });
    daemons.push(daemon);
    await daemon.start();

    // Arm the re-registration waiter BEFORE the drop so the watchdog's fast reconnect can't slip in ahead
    // of it (the recovery takes ~2 heartbeat intervals, well under a frame's worth of time).
    const reRegistered = relay.waitForHello();

    // The link goes half-open: the server can no longer pong, and it sends no `close`. Nothing in the
    // ws `close`-only path can see this — only the daemon's heartbeat watchdog can.
    relay.goSilentHalfOpen();

    // The daemon must detect the missed heartbeat, terminate the dead socket, redial, and re-register —
    // all on its own. `waitForHello` resolving is the proof it recovered without a server-side close.
    await expect(reRegistered).resolves.toBeUndefined();
  });

  it('leaves a HEALTHY link alone — a live link that keeps ponging never gets torn down', async () => {
    // Guards against the inverse regression: if the pong-reset ever inverted, the watchdog would terminate a
    // perfectly good socket every interval and thrash reconnects on every real session. Here the relay is
    // never silenced, so it auto-pongs each heartbeat — the link must survive many intervals untouched.
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: createFakeAgentAdapter([]),
      logger: silent,
      reconnect: { baseMs: 10, maxMs: 40 },
      heartbeat: { intervalMs: 20 },
    });
    daemons.push(daemon);
    await daemon.start();

    // ~12 heartbeat intervals with a healthy (auto-ponging) relay: no re-registration should occur.
    await expect(reconnectedWithin(relay, 250)).resolves.toBe('stable');
  });

  it('installs no watchdog when the heartbeat is disabled (intervalMs <= 0)', async () => {
    // With the watchdog off, a half-open link is NOT self-detected — the daemon stays on the dead socket
    // (this is the pre-fix behavior, kept as an explicit escape hatch). Proves the disable branch is wired.
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: createFakeAgentAdapter([]),
      logger: silent,
      reconnect: { baseMs: 10, maxMs: 40 },
      heartbeat: { intervalMs: 0 },
    });
    daemons.push(daemon);
    await daemon.start();

    relay.goSilentHalfOpen();

    // No heartbeat means nothing detects the silence: the daemon never reconnects on its own.
    await expect(reconnectedWithin(relay, 250)).resolves.toBe('stable');
  });
});
