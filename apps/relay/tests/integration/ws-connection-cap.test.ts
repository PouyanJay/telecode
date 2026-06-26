import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { waitForEnvelope } from '../_helpers/ws';

/**
 * Per-IP WebSocket connection cap (Phase 5 Task 3). Rate limiting bounds how *fast* connections open; this
 * bounds how *many* are held at once, so a single client can't exhaust the relay's memory by holding open
 * thousands of sockets. Proven over the real WS server: once a caller is at the cap, the next connection is
 * closed with the app close code before it can register.
 */
const CONNECTION_CAP_CLOSE_CODE = 4029;

describe('per-IP WebSocket connection cap', () => {
  let app: FastifyInstance | undefined;
  const open: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of open) ws.close();
    open.length = 0;
    await app?.close();
    app = undefined;
  });

  function connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      open.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  /** Connect and complete the hello handshake — its ack proves the relay registered (and counted) us. */
  async function connectRegistered(url: string, deviceId: string): Promise<WebSocket> {
    const ws = await connect(url);
    ws.send(
      JSON.stringify(
        makeEnvelope({ type: 'hello', userId: 'user-1', deviceId, payload: { role: 'browser' } }),
      ),
    );
    await waitForEnvelope(ws, (envelope) => envelope.type === 'hello.ack');
    return ws;
  }

  it('closes a new connection once the caller is at the cap', async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }), maxConnectionsPerIp: 2 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    // Two registered connections fill the per-IP budget (all from 127.0.0.1).
    await connectRegistered(url, 'device-a');
    await connectRegistered(url, 'device-b');

    // The third is accepted at the socket level then immediately closed with the cap code.
    const third = new WebSocket(url);
    open.push(third);
    const closeCode = await new Promise<number>((resolve) => {
      third.once('close', (code) => resolve(code));
    });

    expect(closeCode).toBe(CONNECTION_CAP_CLOSE_CODE);
  });

  it('frees a slot when a connection closes', async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }), maxConnectionsPerIp: 1 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    const first = await connectRegistered(url, 'device-a');
    // Close it and wait for the server to observe the close (so the count is decremented).
    const closed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    first.close();
    await closed;

    // A fresh connection now fits within the freed budget.
    const second = await connectRegistered(url, 'device-b');
    expect(second.readyState).toBe(WebSocket.OPEN);
  });
});
