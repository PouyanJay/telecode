import { randomUUID } from 'node:crypto';

import { WS_CLOSE_TRY_AGAIN } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { DaemonUnauthorizedError } from './daemon-unauthorized-error';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Re-auth on a revoked/invalid device token. The relay closes the daemon's WS with code 4001 when the
 * presented device token doesn't match an ACTIVE device (revoked, or from a different DB). A daemon that
 * blindly redials the same dead token loops forever — so `start()` must reject with a
 * {@link DaemonUnauthorizedError} on the first connect, and a later revocation (surfaced on a reconnect)
 * must fire `onUnauthorized` and stop redialing, so the composition root can clear + re-pair.
 *
 * The last test pins the OPPOSITE wire-contract guarantee: a NON-4001 close (WS_CLOSE_TRY_AGAIN, sent when
 * the relay's DB is transiently unavailable) must NOT re-pair — the daemon just reconnects with its
 * existing credentials. No daemon-code change is needed for this (any non-4001 close already reconnects);
 * the test locks that in as a cross-package contract so a future close-handler change can't regress it.
 */
const silent = pino({ level: 'silent' });

describe('daemon re-auth on a rejected device token', () => {
  const daemons: Daemon[] = [];
  const relays: FakeRelay[] = [];

  afterEach(async () => {
    await Promise.all(daemons.map((d) => d.stop().catch(() => undefined)));
    daemons.length = 0;
    await Promise.all(relays.map((r) => r.close()));
    relays.length = 0;
  });

  function makeDaemon(
    relay: FakeRelay,
    userId: string,
    deviceId: string,
    onUnauthorized?: () => void,
  ) {
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      deviceToken: 'dt_test',
      logger: silent,
      reconnect: { baseMs: 5, maxMs: 20 },
      ...(onUnauthorized ? { onUnauthorized } : {}),
    });
    daemons.push(daemon);
    return daemon;
  }

  it('rejects start() with DaemonUnauthorizedError when the relay rejects the initial hello', async () => {
    // Arrange — the relay rejects every hello (as if this device were revoked)
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId, { rejectHello: true });
    relays.push(relay);

    // Act + Assert
    await expect(makeDaemon(relay, userId, deviceId).start()).rejects.toBeInstanceOf(
      DaemonUnauthorizedError,
    );
  });

  it('fires onUnauthorized and stops redialing when a revoked token is rejected on reconnect', async () => {
    // Arrange — connects fine at first (the relay acks the first hello)
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);

    let resolveUnauthorized!: () => void;
    const unauthorized = new Promise<void>((resolve) => {
      resolveUnauthorized = resolve;
    });
    const daemon = makeDaemon(relay, userId, deviceId, () => resolveUnauthorized());
    await daemon.start();

    // Act — the device is now revoked: the relay rejects the next hello, and the link drops → the daemon
    // reconnects, presents the same (now-dead) token, and is rejected with 4001.
    relay.rejectHellos();
    relay.dropConnection();

    // Assert — onUnauthorized fires (or the test times out), and the daemon does NOT keep redialing.
    await unauthorized;
    const NO_HELLO = Symbol('no-hello');
    const redial = await Promise.race([
      relay.waitForHello().then(() => 'redialed'),
      new Promise<typeof NO_HELLO>((resolve) => setTimeout(() => resolve(NO_HELLO), 150)),
    ]);
    expect(redial).toBe(NO_HELLO);
  });

  it('reconnects and retries (never re-pairs) when a hello is closed with WS_CLOSE_TRY_AGAIN', async () => {
    // A transient DB outage (cold Supabase free tier) closes the hello with the retryable code, NOT 4001.
    // The daemon must ride past it — reconnect and register with its EXISTING token — without ever firing
    // onUnauthorized (which would clear credentials and re-pair, a human step).
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);

    let unauthorizedFired = false;
    // Reject the FIRST hello with the retryable code, then accept — the retry must succeed.
    relay.rejectNextHelloWith(WS_CLOSE_TRY_AGAIN);
    const daemon = makeDaemon(relay, userId, deviceId, () => {
      unauthorizedFired = true;
    });

    // start() resolves only once a hello.ack lands — i.e. the retry after the retryable close registered.
    await expect(daemon.start()).resolves.toBeUndefined();
    expect(unauthorizedFired).toBe(false);
  });
});
