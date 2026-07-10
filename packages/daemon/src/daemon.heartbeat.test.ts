import { randomUUID } from 'node:crypto';

import { makeEnvelope } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 *
 * AD — timing-based by design (exempt from the "no timing-based tests" rule): the unit under test IS a
 * wall-clock `setInterval` watchdog over real sockets, so these drive real timers and observe event-driven
 * promises (never a fixed `sleep` as a sync barrier). Silence budgets are set generously (grace rounds ×
 * interval) so CPU contention can't false-fire; a fully deterministic rewrite would need an injected clock
 * threaded through the socket layer — out of proportion to the risk given the generous margins.
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

  it('stays connected on app traffic when WS pongs are not returned (any inbound resets liveness)', async () => {
    // The twitchiness fix: on an idle connection the cloud ingress doesn't always round-trip a WS pong, but
    // app frames still flow. So the watchdog must reset liveness on ANY inbound activity, not just a pong —
    // a link demonstrably carrying traffic must never be torn down. `autoPong: false` = an ingress that
    // never pongs; the echo round-trips are the only proof of life, and they must suffice.
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId, { autoPong: false });
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: createFakeAgentAdapter([]),
      logger: silent,
      reconnect: { baseMs: 10, maxMs: 40 },
      // A generous silence budget (3 rounds × 30ms = 90ms) so CPU contention between echoes can't
      // false-terminate; the pre-fix watchdog tore down on the FIRST missed pong regardless, so this
      // stays a clean red→green discriminator.
      heartbeat: { intervalMs: 30, maxSilentRounds: 3 },
    });
    daemons.push(daemon);
    await daemon.start();

    // Resolves only if the daemon tears the link down and re-registers — which must NOT happen here.
    const reHello = relay.waitForHello().then(() => 'reconnected' as const);

    // Pump inbound app traffic for ~200ms (well past the 90ms silence budget) — each echo the daemon
    // receives is inbound activity. A per-pong watchdog (pre-fix) would have terminated mid-pump despite
    // this traffic; racing each echo reply against the re-hello makes that failure explicit (not a hang).
    for (let i = 0; i < 16; i += 1) {
      relay.send(makeEnvelope({ type: 'echo', userId, deviceId, payload: { text: 'ka' } }));
      const outcome = await Promise.race([
        relay.waitForFrame((e) => e.type === 'echo.reply').then(() => 'reply' as const),
        reHello,
      ]);
      expect(outcome, `link torn down mid-traffic at round ${i}`).toBe('reply');
      await delay(10);
    }
    // Each echo reply above (the last included) confirms the link was still up at that moment — so no
    // teardown occurred across the whole traffic span. (A trailing quiet window is deliberately NOT asserted
    // stable here: once traffic AND pongs both stop, the link IS silent and a reconnect is then correct.)
  });

  it('still reconnects a genuinely silent link even when WS pongs never return (autoPong off, no traffic)', async () => {
    // The other branch: with the ingress never ponging AND no app traffic, the link is truly silent — the
    // watchdog must still terminate + reconnect after maxSilentRounds (this is the half-open bug it exists
    // for, in the autoPong-off flavor rather than goSilentHalfOpen's full TCP pause).
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId, { autoPong: false });
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: createFakeAgentAdapter([]),
      logger: silent,
      reconnect: { baseMs: 10, maxMs: 40 },
      heartbeat: { intervalMs: 20, maxSilentRounds: 2 },
    });
    daemons.push(daemon);
    await daemon.start();

    const reRegistered = relay.waitForHello();
    // No traffic and no pong → silence for maxSilentRounds → terminate → redial → re-register on its own.
    await expect(reRegistered).resolves.toBeUndefined();
  });

  it('a relay-initiated ping keeps an otherwise-idle link alive (any inbound, not just a pong)', async () => {
    // The relay's own keepalive ping (relay→daemon) is inbound liveness too — receiving it must reset the
    // watchdog exactly like a pong. autoPong off + no app frames, but the relay pings each round: no drop.
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId, { autoPong: false });
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: createFakeAgentAdapter([]),
      logger: silent,
      reconnect: { baseMs: 10, maxMs: 40 },
      heartbeat: { intervalMs: 30, maxSilentRounds: 3 },
    });
    daemons.push(daemon);
    await daemon.start();

    const reHello = relay.waitForHello().then(() => 'reconnected' as const);
    // Ping the daemon every ~10ms for ~200ms (well past the 90ms budget); each ping is inbound liveness.
    for (let i = 0; i < 18; i += 1) {
      relay.pingDaemon();
      await delay(10);
    }
    const outcome = await Promise.race([
      reHello,
      new Promise<'stable'>((resolve) => setTimeout(() => resolve('stable'), 20)),
    ]);
    expect(outcome).toBe('stable');
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
