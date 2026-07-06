import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pairDevice } from './pairing';

/**
 * The RFC 8628 client against a real (local) HTTP relay stand-in: the code request must carry the
 * daemon's identity fields — including `prior_device_token` restore evidence when re-pairing after a
 * revoke — and the poll loop must resolve on approval. The wire bodies are asserted verbatim; this is
 * the daemon's half of the restore-grant contract.
 */
interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
}

describe('pairDevice', () => {
  let server: Server;
  let relayHttpUrl: string;
  let requests: RecordedRequest[];
  let pollResponses: object[];
  let codeRequestStatus: number;

  beforeEach(async () => {
    requests = [];
    pollResponses = [];
    codeRequestStatus = 200;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        requests.push({ url: req.url ?? '', body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/device/code') {
          if (codeRequestStatus !== 200) {
            res.statusCode = codeRequestStatus;
            res.end(JSON.stringify({ error: 'boom' }));
            return;
          }
          res.end(
            JSON.stringify({
              device_code: 'dc-1',
              user_code: 'ABCD-2345',
              verification_uri: 'http://relay.test/activate',
              expires_in: 300,
              interval: 1,
            }),
          );
          return;
        }
        res.end(JSON.stringify(pollResponses.shift() ?? { status: 'authorization_pending' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    relayHttpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('sends prior_device_token restore evidence on the code request and resolves on approval', async () => {
    pollResponses.push({
      status: 'approved',
      device_token: 'dt_new',
      user_id: 'user-1',
      device_id: 'device-1',
    });

    const creds = await pairDevice({
      relayHttpUrl,
      name: 'mbp',
      os: 'macOS 15.4',
      publicKey: 'pk-base64',
      priorDeviceToken: 'dt_prior',
      intervalMs: 1,
    });

    expect(creds).toEqual({ deviceToken: 'dt_new', userId: 'user-1', deviceId: 'device-1' });
    const codeRequest = requests.find((r) => r.url === '/device/code');
    expect(codeRequest?.body).toEqual({
      name: 'mbp',
      os: 'macOS 15.4',
      public_key: 'pk-base64',
      prior_device_token: 'dt_prior',
    });
  });

  it('omits prior_device_token entirely on a fresh pair (no empty-string claims)', async () => {
    pollResponses.push({
      status: 'approved',
      device_token: 'dt_new',
      user_id: 'user-1',
      device_id: 'device-1',
    });

    await pairDevice({ relayHttpUrl, name: 'mbp', intervalMs: 1 });

    const codeRequest = requests.find((r) => r.url === '/device/code');
    expect(codeRequest?.body).toEqual({ name: 'mbp' });
    expect('prior_device_token' in (codeRequest?.body ?? {})).toBe(false);
  });

  it('surfaces the pairing prompt before polling and keeps polling until approval', async () => {
    pollResponses.push({ status: 'authorization_pending' });
    pollResponses.push({
      status: 'approved',
      device_token: 'dt_new',
      user_id: 'user-1',
      device_id: 'device-1',
    });
    const promptedBeforePoll: number[] = [];

    await pairDevice({
      relayHttpUrl,
      intervalMs: 1,
      onPrompt: ({ userCode, verificationUri }) => {
        expect(userCode).toBe('ABCD-2345');
        expect(verificationUri).toBe('http://relay.test/activate');
        promptedBeforePoll.push(requests.filter((r) => r.url === '/device/token').length);
      },
    });

    // The prompt fired before any poll went out; approval took a second poll.
    expect(promptedBeforePoll).toEqual([0]);
    expect(requests.filter((r) => r.url === '/device/token')).toHaveLength(2);
  });

  it('throws when the relay reports the code expired', async () => {
    pollResponses.push({ status: 'expired' });

    await expect(pairDevice({ relayHttpUrl, intervalMs: 1 })).rejects.toThrow(
      'device code expired before approval',
    );
  });

  it('throws with the status when the code request itself fails (relay down/erroring)', async () => {
    codeRequestStatus = 503;

    await expect(pairDevice({ relayHttpUrl, intervalMs: 1 })).rejects.toThrow(
      'device/code request failed: 503',
    );
  });

  it('throws a timeout once the poll budget is exhausted without approval', async () => {
    // The server only ever answers authorization_pending; a budget of 2 polls must give up cleanly.
    await expect(pairDevice({ relayHttpUrl, intervalMs: 1, maxAttempts: 2 })).rejects.toThrow(
      'device pairing timed out',
    );
    expect(requests.filter((r) => r.url === '/device/token')).toHaveLength(2);
  });
});
