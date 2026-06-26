import type { AddressInfo } from 'node:net';

import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon } from '../_helpers/ws';

/**
 * Phase 4 Task 8 — the relay's bounded ciphertext cache. The relay keeps the recent encrypted frames it
 * forwards per session (and the latest `session.key`) and replays them to a browser on `session.subscribe`,
 * so a reopen shows recent history immediately — even while the daemon is offline/reconnecting. The relay
 * caches the opaque forwarded strings only; it never reads a payload (invariant #5). Registry-less, no DB.
 */
const userId = 'user-cache';
const deviceId = 'device-cache';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];

async function startRelay(cache?: { maxFramesPerSession?: number }): Promise<string> {
  const app = await buildRelay({ logger: pino({ level: 'silent' }), ...(cache ? { cache } : {}) });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
}

/** Send a ciphertext-shaped session frame from the daemon (opaque base64-ish string + nonce). */
function daemonSend(daemon: WebSocket, type: string, sessionId: string, payload: string): void {
  daemon.send(
    JSON.stringify(
      makeEnvelope({
        type: type as Envelope['type'],
        userId,
        deviceId,
        sessionId,
        payload,
        nonce: 'nonce',
      }),
    ),
  );
}

function collect(socket: WebSocket): Envelope[] {
  const frames: Envelope[] = [];
  socket.on('message', (raw: Buffer) => frames.push(parseEnvelope(JSON.parse(raw.toString()))));
  return frames;
}

function subscribe(browser: WebSocket, sessionId: string): void {
  browser.send(
    JSON.stringify(
      makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }),
    ),
  );
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('relay ciphertext cache (Phase 4 Task 8)', () => {
  it('replays a session’s cached ciphertext to a browser that subscribes (instant reopen)', async () => {
    const url = await startRelay();
    const sid = 'sess-replay';

    // The daemon streams a session while no browser is watching — it is only cached.
    const daemon = await connectDaemon(url, userId, deviceId);
    sockets.push(daemon);
    daemonSend(daemon, 'session.key', sid, 'CIPHER_KEY');
    daemonSend(daemon, 'session.started', sid, 'CIPHER_STARTED');
    daemonSend(daemon, 'agent.message', sid, 'CIPHER_MSG');
    await delay(40); // let the relay cache them

    // A browser reopens and subscribes → the relay replays the cached ciphertext immediately.
    const browser = await connectBrowser(url, userId, deviceId);
    sockets.push(browser);
    const got = collect(browser);
    subscribe(browser, sid);
    await delay(60);

    const types = got.map((e) => e.type);
    expect(types).toContain('session.key');
    expect(types).toContain('session.started');
    expect(types).toContain('agent.message');
    // The key is replayed before the stream, so the browser can decrypt what follows.
    expect(types.indexOf('session.key')).toBeLessThan(types.indexOf('session.started'));
    // Ciphertext only: the relay replayed the opaque payloads verbatim — it never read or altered them.
    expect(got.find((e) => e.type === 'agent.message')?.payload).toBe('CIPHER_MSG');
  });

  it('bounds the cache to the most recent frames per session (ring buffer)', async () => {
    const url = await startRelay({ maxFramesPerSession: 3 });
    const sid = 'sess-bounded';

    const daemon = await connectDaemon(url, userId, deviceId);
    sockets.push(daemon);
    for (let i = 0; i < 5; i += 1) daemonSend(daemon, 'agent.message', sid, `CIPHER_${i}`);
    await delay(40);

    const browser = await connectBrowser(url, userId, deviceId);
    sockets.push(browser);
    const got = collect(browser);
    subscribe(browser, sid);
    await delay(60);

    // Only the last 3 of the 5 streamed frames survive the ring; the oldest two were evicted.
    const payloads = got.filter((e) => e.type === 'agent.message').map((e) => e.payload);
    expect(payloads).toEqual(['CIPHER_2', 'CIPHER_3', 'CIPHER_4']);
  });

  it('replays nothing for an unknown session', async () => {
    const url = await startRelay();
    const browser = await connectBrowser(url, userId, deviceId);
    sockets.push(browser);
    const got = collect(browser);
    subscribe(browser, 'never-seen');
    await delay(40);
    // No daemon is connected, so the only frame is the device.presence offline notice (Task 3) — never a
    // replayed session frame, since nothing was cached for this session.
    expect(got.filter((e) => e.type !== 'device.presence')).toHaveLength(0);
  });
});
