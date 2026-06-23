import type { AddressInfo } from 'node:net';

import { createDaemon, type Daemon } from '@telecode/daemon';
import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildRelay } from '../src/relay';

const USER_ID = 'u_1';
const DEVICE_ID = 'd_1';

/** Resolve with the first envelope a socket receives that matches `predicate`. */
function waitForEnvelope(
  socket: WebSocket,
  predicate: (envelope: Envelope) => boolean,
  timeoutMs = 5000,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('timed out waiting for envelope'));
    }, timeoutMs);

    function onMessage(raw: WebSocket.RawData): void {
      const envelope = parseEnvelope(JSON.parse(raw.toString()));
      if (predicate(envelope)) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(envelope);
      }
    }

    socket.on('message', onMessage);
  });
}

describe('walking skeleton: browser -> relay -> daemon -> relay -> browser echo', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let relayUrl: string;
  const daemonLogs: string[] = [];

  beforeAll(async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    relayUrl = `ws://127.0.0.1:${address.port}/ws`;

    const daemonLogger = pino(
      { level: 'info' },
      { write: (chunk: string) => daemonLogs.push(chunk) },
    );
    daemon = createDaemon({
      relayUrl,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      logger: daemonLogger,
    });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    await app.close();
  });

  it('echoes a string sent by the browser back to the browser', async () => {
    const browser = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      browser.once('open', () => resolve());
      browser.once('error', reject);
    });

    const ack = waitForEnvelope(browser, (e) => e.type === 'hello.ack');
    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'hello',
          userId: USER_ID,
          deviceId: DEVICE_ID,
          payload: { role: 'browser' },
        }),
      ),
    );
    await ack;

    const reply = waitForEnvelope(browser, (e) => e.type === 'echo.reply');
    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'echo',
          userId: USER_ID,
          deviceId: DEVICE_ID,
          payload: { text: 'ping' },
        }),
      ),
    );

    const envelope = await reply;
    expect(envelope.payload).toEqual({ text: 'ping' });

    // Log triangulation: the daemon must have logged handling this echo for this device.
    expect(daemonLogs.some((line) => line.includes('echo received') && line.includes('ping'))).toBe(
      true,
    );

    browser.close();
  });
});
