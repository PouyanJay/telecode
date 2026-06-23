import type { AddressInfo } from 'node:net';

import { createDaemon, type Daemon } from '@telecode/daemon';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRelay } from '../src/relay';
import { connectBrowser, sendEcho, waitForEnvelope } from './_helpers/ws';

const USER_ID = 'u_1';
const DEVICE_ID = 'd_1';

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
    daemon = createDaemon({ relayUrl, userId: USER_ID, deviceId: DEVICE_ID, logger: daemonLogger });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    await app.close();
  });

  it('echoes a string sent by the browser back to the browser', async () => {
    const browser = await connectBrowser(relayUrl, USER_ID, DEVICE_ID);

    const reply = waitForEnvelope(browser, (e) => e.type === 'echo.reply');
    sendEcho(browser, USER_ID, DEVICE_ID, 'ping');

    const envelope = await reply;
    expect(envelope.payload).toEqual({ text: 'ping' });

    // Log triangulation: the daemon must have logged handling this echo for this device.
    expect(daemonLogs.some((line) => line.includes('echo received') && line.includes('ping'))).toBe(
      true,
    );

    browser.close();
  });
});
