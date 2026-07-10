import type { AddressInfo } from 'node:net';

import { makeEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import type WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * App-level link liveness (`link.ping` → `link.pong`). WS protocol ping/pong control frames are not
 * end-to-end through a cloud ingress — the proxy can answer them itself while the relay app is
 * unreachable (the 2026-07-10 zombie-link incident). So peers probe with a `link.ping` ENVELOPE that
 * only the relay application can answer: the `link.pong` reply is the end-to-end proof of life the
 * daemon's and web client's watchdogs count. The probe is connection-scoped routing metadata — the
 * relay answers on the SAME socket, touches no database, and never routes it to the other peer.
 *
 * AD — the negative assertions ("never forwarded", "never broadcast") use a bounded real-time window
 * (`arrivesWithin`, 300ms) because there is no event to await for something that must NOT happen; this
 * matches the suite's existing convention (frame-identity, max-connection-age).
 */
const sendLinkPing = (socket: WebSocket, userId: string, deviceId: string): void => {
  socket.send(JSON.stringify(makeEnvelope({ type: 'link.ping', userId, deviceId, payload: {} })));
};

/** Resolve `true` if a frame matching `predicate` arrives within `ms`, else `false`. */
const arrivesWithin = (
  socket: WebSocket,
  predicate: (e: Envelope) => boolean,
  ms: number,
): Promise<boolean> =>
  waitForEnvelope(socket, predicate, ms)
    .then(() => true)
    .catch(() => false);

describe('relay: app-level link liveness (link.ping → link.pong)', () => {
  let app: FastifyInstance;
  let relayUrl: string;
  const userId = 'user-link-liveness';

  beforeAll(async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers a daemon link.ping with a link.pong on the same socket', async () => {
    const deviceId = 'device-daemon-ping';
    const daemon = await connectDaemon(relayUrl, userId, deviceId);

    const pong = waitForEnvelope(daemon, (e) => e.type === 'link.pong');
    sendLinkPing(daemon, userId, deviceId);

    const envelope = await pong;
    expect(envelope.user_id).toBe(userId);
    expect(envelope.device_id).toBe(deviceId);

    daemon.close();
  });

  it('answers a browser link.ping itself and never forwards the probe to the daemon', async () => {
    const deviceId = 'device-browser-ping';
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    const pong = waitForEnvelope(browser, (e) => e.type === 'link.pong');
    const forwarded = arrivesWithin(daemon, (e) => e.type === 'link.ping', 300);
    sendLinkPing(browser, userId, deviceId);

    await pong;
    // The probe is connection-scoped: it must be answered by the relay, not routed to the daemon
    // (an older daemon would drop it, but forwarding would still be a contract leak).
    await expect(forwarded).resolves.toBe(false);

    daemon.close();
    browser.close();
  });

  it('drops a stray link.pong instead of broadcasting it to browsers', async () => {
    const deviceId = 'device-stray-pong';
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    const leaked = arrivesWithin(browser, (e) => e.type === 'link.pong', 300);
    daemon.send(JSON.stringify(makeEnvelope({ type: 'link.pong', userId, deviceId, payload: {} })));

    // A pong is only ever a relay-generated REPLY — a peer-sent one is dropped, never fanned out.
    await expect(leaked).resolves.toBe(false);

    daemon.close();
    browser.close();
  });
});
