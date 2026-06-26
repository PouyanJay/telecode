import type { AddressInfo } from 'node:net';

import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

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

  it('does not send a cold browser an offline frame when its daemon is already online', async () => {
    const deviceId = 'device-already-online';
    await connectDaemon(relayUrl, userId, deviceId); // daemon online first

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
    // Give any stray presence frame a tick to arrive, then assert none did.
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.some(presenceOf)).toBe(false);
    ws.close();
  });
});
