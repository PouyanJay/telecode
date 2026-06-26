import type { AddressInfo } from 'node:net';

import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, sendEcho, waitForEnvelope } from '../_helpers/ws';

/**
 * Phase 4 Task 3 — device presence. The relay tells watching browsers when the daemon behind their
 * channel connects or drops, so the UI can pause live sessions (offline) and resume them (online)
 * without a reload. Registry-less relay — presence is pure routing metadata the relay generates itself,
 * so this needs no Postgres.
 */
const presenceOf = (e: Envelope): boolean => e.type === 'device.presence';
const isOnline = (e: Envelope): boolean => (e.payload as { online: boolean }).online;
const onlineFrame = (e: Envelope): boolean => presenceOf(e) && isOnline(e);
const offlineFrame = (e: Envelope): boolean => presenceOf(e) && !isOnline(e);

describe('relay: device presence (Phase 4 Task 3)', () => {
  let app: FastifyInstance;
  let relayUrl: string;
  const userId = 'user-presence';

  beforeAll(async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('broadcasts online when the daemon registers and offline when it drops', async () => {
    const deviceId = 'device-up-down';
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    // Daemon comes online → the already-watching browser is told. (It first got an offline frame on
    // connect since no daemon was registered yet; wait specifically for the online transition.)
    const online = waitForEnvelope(browser, onlineFrame);
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    await online;

    // Daemon drops → the browser is told the device went offline.
    const offline = waitForEnvelope(browser, offlineFrame);
    daemon.close();
    await offline;

    browser.close();
  });

  it('tells a browser the device is offline if it connects while no daemon is registered', async () => {
    const deviceId = 'device-cold-offline';
    const ws = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // Attach the presence waiter before the handshake so it can't be missed.
    const presence = waitForEnvelope(ws, presenceOf);
    ws.send(
      JSON.stringify(
        makeEnvelope({ type: 'hello', userId, deviceId, payload: { role: 'browser' } }),
      ),
    );
    expect(isOnline(await presence)).toBe(false);
    ws.close();
  });

  it('drops a daemon that stops answering heartbeats and tells browsers it went offline (Phase 4 T4)', async () => {
    // A relay with a fast heartbeat so the sweep runs within the test.
    const beatApp = await buildRelay({
      logger: pino({ level: 'silent' }),
      heartbeat: { intervalMs: 40 },
    });
    await beatApp.listen({ port: 0, host: '127.0.0.1' });
    const beatUrl = `ws://127.0.0.1:${(beatApp.server.address() as AddressInfo).port}/ws`;
    const deviceId = 'device-heartbeat';

    const browser = await connectBrowser(beatUrl, userId, deviceId);
    const online = waitForEnvelope(browser, onlineFrame);
    const daemon = await connectDaemon(beatUrl, userId, deviceId);
    await online;

    // The daemon goes silent (laptop sleep / half-open link): pause its socket so it can't pong. The
    // connection never fires `close` on its own — only the relay's heartbeat detects it.
    (daemon as unknown as { _socket?: { pause(): void } })._socket?.pause();

    // Within a couple of sweeps the relay terminates the dead daemon and tells the browser it's offline.
    await waitForEnvelope(browser, offlineFrame, 2000);

    browser.close();
    await beatApp.close();
  });

  it('does not send a cold browser an offline frame when its daemon is already online', async () => {
    const deviceId = 'device-already-online';
    const daemon = await connectDaemon(relayUrl, userId, deviceId); // daemon online first

    const ws = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const frames: Envelope[] = [];
    ws.on('message', (raw: Buffer) => frames.push(parseEnvelope(JSON.parse(raw.toString()))));
    ws.send(
      JSON.stringify(
        makeEnvelope({ type: 'hello', userId, deviceId, payload: { role: 'browser' } }),
      ),
    );
    await waitForEnvelope(ws, (e) => e.type === 'hello.ack');
    // The relay sends the ack BEFORE its presence decision, so the ack alone isn't a barrier. Send an
    // echo and wait for the relay to forward it to the online daemon: same-socket ordering guarantees the
    // relay finished this browser's hello (presence decision included) first, so any stray presence frame
    // is already in `frames`. No timing wait.
    sendEcho(ws, userId, deviceId, 'barrier');
    await waitForEnvelope(daemon, (e) => e.type === 'echo');
    expect(frames.some(presenceOf)).toBe(false);
    ws.close();
  });
});
