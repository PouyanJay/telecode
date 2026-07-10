import type { AddressInfo } from 'node:net';

import { makeEnvelope, WS_CLOSE_TRY_AGAIN, WS_CLOSE_UNAUTHORIZED } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceRegistry } from '../../src/registry/device-registry';
import { buildRelay } from '../../src/relay';
import { fakeDeviceRegistry } from '../_helpers/fake-device-registry';
import { connectDaemon } from '../_helpers/ws';

/**
 * Deploy safety: the daemon-hello device-token check runs a DB query. A cold/paused Supabase free-tier
 * instance (common right after a relay redeploy) makes that query throw — which must NOT be conflated with
 * a genuinely invalid token. A transient DB error closes with WS_CLOSE_TRY_AGAIN so the daemon reconnects
 * and retries with its EXISTING credentials, never a 4001 that would force a re-pair (a human step) and
 * knock a valid device offline. A real invalid token still closes 4001.
 */
const USER = 'user-db';
const DEVICE = 'device-db';
const TOKEN = 'dt_db-unavailable-test';

/** Open a raw daemon WS, send its hello, and resolve with the close code the relay responds with. */
function daemonHelloCloseCode(url: string, ms = 2000): Promise<number | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(null);
    }, ms);
    ws.once('open', () =>
      ws.send(
        JSON.stringify(
          makeEnvelope({
            type: 'hello',
            userId: USER,
            deviceId: DEVICE,
            payload: { role: 'daemon', token: TOKEN },
          }),
        ),
      ),
    );
    ws.once('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('relay: daemon hello when the device-token DB check is unavailable (deploy safety)', () => {
  let app: FastifyInstance | undefined;
  let url: string;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(registry: DeviceRegistry): Promise<void> {
    app = await buildRelay({ logger: pino({ level: 'silent' }), deviceRegistry: registry });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  }

  it('closes with the retryable code (not 4001) when the token lookup throws (transient DB outage)', async () => {
    await start(
      fakeDeviceRegistry({
        findActiveByTokenHash: async () => {
          throw new Error('ECONNREFUSED: database unavailable');
        },
      }),
    );
    // WS_CLOSE_TRY_AGAIN → the daemon reconnects with its existing credentials (never re-pairs).
    expect(await daemonHelloCloseCode(url)).toBe(WS_CLOSE_TRY_AGAIN);
  });

  it('still closes 4001 for a genuinely invalid token (lookup returns no device)', async () => {
    await start(fakeDeviceRegistry({ findActiveByTokenHash: async () => null }));
    expect(await daemonHelloCloseCode(url)).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('acks a valid device (lookup returns a matching device) — no close', async () => {
    await start(
      fakeDeviceRegistry({
        findActiveByTokenHash: async () => ({
          id: DEVICE,
          userId: USER,
          name: 'mbp',
          revokedAt: null,
        }),
        touchLastSeen: async () => undefined,
      }),
    );
    // connectDaemon resolves on hello.ack — reaching it proves the happy path is unaffected by the guard.
    const daemon = await connectDaemon(url, USER, DEVICE, { token: TOKEN });
    expect(daemon.readyState).toBe(WebSocket.OPEN);
    daemon.close();
  });
});
