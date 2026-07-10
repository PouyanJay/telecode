import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRelay, WS_CLOSE_CODE_NORMAL } from '../../src/relay';
import { connectDaemon } from '../_helpers/ws';

/**
 * Max connection age (deploy safety). Azure Container Apps keeps a deprecated revision alive to drain open
 * WebSockets, so — with the heartbeat now tolerant of idle links — a peer can stick to the OLD revision
 * after a rolling deploy indefinitely (and read as offline on the new one, which serves the web). The relay
 * caps each connection's age and closes it gracefully so the client reconnects onto the current revision.
 */
const closeWithin = (ws: WebSocket, ms: number): Promise<{ code: number } | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    ws.on('close', (code: number) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });

describe('relay: max connection age (deploy safety)', () => {
  let app: FastifyInstance | undefined;
  let url: string;
  const userId = 'user-maxage';

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(maxConnectionAge: { baseMs?: number; jitterMs?: number }): Promise<void> {
    app = await buildRelay({ logger: pino({ level: 'silent' }), maxConnectionAge });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  }

  it('gracefully closes a connection once it reaches its max age (prompting a reconnect)', async () => {
    await start({ baseMs: 150, jitterMs: 0 });
    const daemon = await connectDaemon(url, userId, 'device-maxage');

    const closed = await closeWithin(daemon, 1500);
    expect(closed).not.toBeNull();
    // A normal close (NOT 4001) — the daemon/browser reconnect on it rather than treating it as an auth
    // failure, migrating onto the current revision.
    expect(closed?.code).toBe(WS_CLOSE_CODE_NORMAL);
  });

  it('holds the connection until baseMs, then closes within the jittered window', async () => {
    // Guards the `baseMs + random(0, jitterMs)` arithmetic + the Math.max(0, ...) jitter floor: it must not
    // fire early (before baseMs) and must fire somewhere inside [baseMs, baseMs + jitterMs).
    await start({ baseMs: 300, jitterMs: 300 });
    const daemon = await connectDaemon(url, userId, 'device-jittered');

    // Not before baseMs.
    expect(await closeWithin(daemon, 200)).toBeNull();
    // But within baseMs + jitterMs (+ margin) it does close, normally.
    const closed = await closeWithin(daemon, 800);
    expect(closed?.code).toBe(WS_CLOSE_CODE_NORMAL);
  });

  it('leaves connections open when disabled (baseMs <= 0)', async () => {
    await start({ baseMs: 0 });
    const daemon = await connectDaemon(url, userId, 'device-noage');

    // No age cap and the default 30s heartbeat can't fire in this window — the connection must stay open.
    const closed = await closeWithin(daemon, 300);
    expect(closed).toBeNull();

    daemon.close();
  });
});
