import type { AddressInfo } from 'node:net';

import { createDaemon, type Daemon } from '@telecode/daemon';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRelay } from '../src/relay';
import { connectBrowser, sendEcho, waitForEnvelope } from './_helpers/ws';

// One relay + one daemon registered for (u_1, d_1) for the whole suite.
describe('echo variants & relay routing', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let relayUrl: string;

  beforeAll(async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    relayUrl = `ws://127.0.0.1:${address.port}/ws`;
    daemon = createDaemon({
      relayUrl,
      userId: 'u_1',
      deviceId: 'd_1',
      logger: pino({ level: 'silent' }),
    });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    await app.close();
  });

  it('round-trips an empty string', async () => {
    const browser = await connectBrowser(relayUrl, 'u_1', 'd_1');
    const reply = waitForEnvelope(browser, (e) => e.type === 'echo.reply');
    sendEcho(browser, 'u_1', 'd_1', '');
    expect((await reply).payload).toEqual({ text: '' });
    browser.close();
  });

  it('broadcasts the reply to every browser watching the same channel', async () => {
    const browserA = await connectBrowser(relayUrl, 'u_1', 'd_1');
    const browserB = await connectBrowser(relayUrl, 'u_1', 'd_1');

    const replyA = waitForEnvelope(browserA, (e) => e.type === 'echo.reply');
    const replyB = waitForEnvelope(browserB, (e) => e.type === 'echo.reply');

    sendEcho(browserA, 'u_1', 'd_1', 'broadcast');

    const [a, b] = await Promise.all([replyA, replyB]);
    expect(a.payload).toEqual({ text: 'broadcast' });
    expect(b.payload).toEqual({ text: 'broadcast' });

    browserA.close();
    browserB.close();
  });

  it('drops an echo when no daemon is registered for the channel (no cross-talk, no crash)', async () => {
    // (u_2, d_2) has no daemon — the relay should log + drop, never deliver.
    const orphan = await connectBrowser(relayUrl, 'u_2', 'd_2');
    const noReply = waitForEnvelope(orphan, (e) => e.type === 'echo.reply', 400);
    sendEcho(orphan, 'u_2', 'd_2', 'anybody?');
    await expect(noReply).rejects.toThrow(/timed out/);
    orphan.close();

    // The relay is still healthy and the live channel still works.
    const browser = await connectBrowser(relayUrl, 'u_1', 'd_1');
    const reply = waitForEnvelope(browser, (e) => e.type === 'echo.reply');
    sendEcho(browser, 'u_1', 'd_1', 'still-alive');
    expect((await reply).payload).toEqual({ text: 'still-alive' });
    browser.close();
  });
});
