import type { AddressInfo } from 'node:net';

import { makeEnvelope, viewerPresencePayloadSchema, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Viewer presence — the mirror of device presence. The relay tells a channel's daemon whether ANY browser
 * is currently watching, so an adopted session only holds a tool for a remote approval while an operator is
 * present (otherwise the daemon defers to Claude Code's own local prompt, never freezing an unwatched local
 * session). Registry-less relay — pure routing metadata the relay generates itself, so this needs no Postgres.
 */
const isViewerPresence = (e: Envelope): boolean => e.type === 'viewer.presence';
// Parse via the schema (not a cast) so the test also proves the relay emits a well-formed viewer.presence.
const isOnline = (e: Envelope): boolean => viewerPresencePayloadSchema.parse(e.payload).online;
// Polarity-specific predicates: a daemon connecting cold receives a `viewer.presence(false)` at
// registration, so a transition assertion must match the exact polarity, not just the type.
const viewerOnline = (e: Envelope): boolean => isViewerPresence(e) && isOnline(e);
const viewerOffline = (e: Envelope): boolean => isViewerPresence(e) && !isOnline(e);

/**
 * Open a raw daemon socket with a viewer-presence waiter armed BEFORE the hello — the frame the relay sends
 * at registration arrives right after hello.ack, so it must not be missed.
 */
async function connectDaemonAwaitingViewerPresence(
  relayUrl: string,
  userId: string,
  deviceId: string,
): Promise<{ socket: WebSocket; presence: Promise<Envelope> }> {
  const socket = new WebSocket(relayUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const presence = waitForEnvelope(socket, isViewerPresence);
  socket.send(
    JSON.stringify(makeEnvelope({ type: 'hello', userId, deviceId, payload: { role: 'daemon' } })),
  );
  return { socket, presence };
}

describe('relay: viewer presence (relay → daemon)', () => {
  let app: FastifyInstance;
  let relayUrl: string;
  const userId = 'user-viewer';

  beforeAll(async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('tells the daemon online when the first browser appears and offline when the last leaves', async () => {
    const deviceId = 'device-viewer-updown';
    const daemon = await connectDaemon(relayUrl, userId, deviceId);

    // A browser appears → the daemon is told an operator is now watching.
    const online = waitForEnvelope(daemon, viewerOnline);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    await online;

    // That browser leaves → the daemon is told nobody is watching.
    const offline = waitForEnvelope(daemon, viewerOffline);
    browser.close();
    await offline;

    daemon.close();
  });

  it('tells a freshly-connected daemon a viewer is already present', async () => {
    const deviceId = 'device-viewer-warm';
    const browser = await connectBrowser(relayUrl, userId, deviceId); // browser first (device offline)
    const { socket, presence } = await connectDaemonAwaitingViewerPresence(
      relayUrl,
      userId,
      deviceId,
    );
    expect(isOnline(await presence)).toBe(true);
    socket.close();
    browser.close();
  });

  it('tells a freshly-connected daemon no viewer is present when it connects cold', async () => {
    const deviceId = 'device-viewer-cold';
    const { socket, presence } = await connectDaemonAwaitingViewerPresence(
      relayUrl,
      userId,
      deviceId,
    );
    expect(isOnline(await presence)).toBe(false);
    socket.close();
  });

  it('only notifies on the 0↔1 transition, not for every additional browser', async () => {
    const deviceId = 'device-viewer-second';
    const daemon = await connectDaemon(relayUrl, userId, deviceId);

    const firstOnline = waitForEnvelope(daemon, viewerOnline);
    const browserA = await connectBrowser(relayUrl, userId, deviceId);
    await firstOnline;

    // A SECOND browser must not produce another viewer.presence frame (the daemon already knows a viewer is
    // present). Prove it via same-socket ordering: with B connected, dropping A leaves one viewer (no
    // frame), then dropping B is the LAST-browser transition — so the next frame the daemon sees is offline.
    const browserB = await connectBrowser(relayUrl, userId, deviceId);
    const nextFrame = waitForEnvelope(daemon, isViewerPresence);
    browserA.close(); // one browser (B) remains → no frame
    browserB.close(); // last browser gone → offline frame
    expect(isOnline(await nextFrame)).toBe(false);

    daemon.close();
  });
});
