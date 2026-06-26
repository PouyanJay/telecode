import type { AddressInfo } from 'node:net';

import { makeEnvelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import type { Telemetry, TelemetryEvent } from '../../src/telemetry';
import { waitForEnvelope } from '../_helpers/ws';

/**
 * The relay feeds the telemetry seam (Phase 5 Task 4). When an operator opts in, the relay should emit
 * aggregate connection lifecycle events — useful for capacity, carrying NO identifiers (no user_id /
 * device_id / channel) and no session content, per the privacy stance. Proven with a recording telemetry
 * injected into a real WS handshake.
 */
describe('relay telemetry emission', () => {
  let app: FastifyInstance | undefined;
  const open: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of open) ws.close();
    open.length = 0;
    await app?.close();
    app = undefined;
  });

  it('records a peer_connected event (role only, no identifiers) on hello', async () => {
    const events: TelemetryEvent[] = [];
    const telemetry: Telemetry = { record: (event) => events.push(event) };
    app = await buildRelay({ logger: pino({ level: 'silent' }), telemetry });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    const ws = new WebSocket(url);
    open.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(
      JSON.stringify(
        makeEnvelope({
          type: 'hello',
          userId: 'user-1',
          deviceId: 'device-1',
          payload: { role: 'browser' },
        }),
      ),
    );
    await waitForEnvelope(ws, (envelope) => envelope.type === 'hello.ack');

    const connected = events.find((e) => e.name === 'peer_connected');
    expect(connected).toEqual({ name: 'peer_connected', role: 'browser' });
    // The event must carry no identifiers — defense against the metadata-leak caveat in the threat model.
    expect(JSON.stringify(connected)).not.toContain('user-1');
    expect(JSON.stringify(connected)).not.toContain('device-1');
  });
});
