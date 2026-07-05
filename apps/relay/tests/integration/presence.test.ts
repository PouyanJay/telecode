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

  it('tells a cold browser the device is ONLINE when its daemon is already registered (snapshot)', async () => {
    // Honesty pass T2: a browser used to get NO presence frame in this case and had to assume — now every
    // cold-connecting browser receives exactly one presence snapshot so it never guesses.
    const deviceId = 'device-already-online';
    const daemon = await connectDaemon(relayUrl, userId, deviceId); // daemon online first

    const ws = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const frames: Envelope[] = [];
    ws.on('message', (raw: Buffer) => frames.push(parseEnvelope(JSON.parse(raw.toString()))));
    const online = waitForEnvelope(ws, onlineFrame);
    ws.send(
      JSON.stringify(
        makeEnvelope({ type: 'hello', userId, deviceId, payload: { role: 'browser' } }),
      ),
    );
    await online;
    // Exactly one snapshot — no duplicate or contradictory presence frames. The echo round-trip through
    // the daemon is the ordering barrier proving the relay finished this browser's hello.
    sendEcho(ws, userId, deviceId, 'barrier');
    await waitForEnvelope(daemon, (e) => e.type === 'echo');
    expect(frames.filter(presenceOf)).toHaveLength(1);
    expect(frames.filter(presenceOf).every(isOnline)).toBe(true);
    ws.close();
    daemon.close();
  });

  it('the offline snapshot still arrives when a second browser joins an offline channel', async () => {
    // Regression guard: the snapshot is per-browser, not per-channel — a browser joining AFTER another
    // one still gets its own offline frame.
    const deviceId = 'device-second-browser';
    const first = await connectBrowser(relayUrl, userId, deviceId);
    const second = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      second.once('open', () => resolve());
      second.once('error', reject);
    });
    const presence = waitForEnvelope(second, presenceOf);
    second.send(
      JSON.stringify(
        makeEnvelope({ type: 'hello', userId, deviceId, payload: { role: 'browser' } }),
      ),
    );
    expect(isOnline(await presence)).toBe(false);
    first.close();
    second.close();
  });
});
