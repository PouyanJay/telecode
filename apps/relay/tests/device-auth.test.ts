import type { AddressInfo } from 'node:net';

import { pairDevice } from '@telecode/daemon';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDeviceAuthService } from '../src/device-auth';
import { buildRelay } from '../src/relay';

describe('DeviceAuthService (unit)', () => {
  it('issues a device code + user code', () => {
    const service = createDeviceAuthService({ verificationUri: 'http://x/activate' });
    const res = service.requestCode();
    expect(res.device_code).toBeTruthy();
    expect(res.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(res.verification_uri).toBe('http://x/activate');
    expect(res.interval).toBeGreaterThan(0);
  });

  it('is authorization_pending until approved, then approved with a token', () => {
    const service = createDeviceAuthService({ verificationUri: 'http://x' });
    const { device_code, user_code } = service.requestCode();

    expect(service.poll(device_code)).toEqual({ status: 'authorization_pending' });

    expect(service.approve(user_code, 'u_42')).toBe(true);

    const result = service.poll(device_code);
    expect(result.status).toBe('approved');
    if (result.status === 'approved') {
      expect(result.user_id).toBe('u_42');
      expect(result.device_token).toMatch(/^dt_/);
    }
  });

  it('rejects approval of an unknown user code', () => {
    const service = createDeviceAuthService({ verificationUri: 'http://x' });
    expect(service.approve('ZZZZ-ZZZZ', 'u_1')).toBe(false);
  });

  it('expires codes based on the injected clock', () => {
    let clock = 1000;
    const service = createDeviceAuthService({
      verificationUri: 'http://x',
      expiresInMs: 500,
      now: () => clock,
    });
    const { device_code, user_code } = service.requestCode();
    clock += 501;
    expect(service.poll(device_code)).toEqual({ status: 'expired' });
    expect(service.approve(user_code, 'u_1')).toBe(false);
  });
});

describe('device pairing round-trip (daemon <-> relay)', () => {
  let app: FastifyInstance;
  let relayHttpUrl: string;

  beforeAll(async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    relayHttpUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('pairs the device once the user approves the code', async () => {
    const credentials = await pairDevice({
      relayHttpUrl,
      intervalMs: 20,
      logger: pino({ level: 'silent' }),
      // Stand in for the signed-in user approving in the browser.
      onPrompt: async ({ userCode }) => {
        const res = await fetch(`${relayHttpUrl}/device/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user_code: userCode, user_id: 'u_paired' }),
        });
        expect(res.ok).toBe(true);
      },
    });

    expect(credentials.userId).toBe('u_paired');
    expect(credentials.deviceToken).toMatch(/^dt_/);
  });
});
