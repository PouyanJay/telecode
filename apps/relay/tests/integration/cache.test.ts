import type { AddressInfo } from 'node:net';

import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Phase 4 Task 8 — the relay's bounded ciphertext cache. The relay keeps the recent encrypted frames it
 * forwards per session (and the latest `session.key`) and replays them to a browser on `session.subscribe`,
 * so a reopen shows recent history immediately — even while the daemon is offline/reconnecting. The relay
 * caches the opaque forwarded strings only; it never reads a payload (invariant #5). Registry-less, no DB.
 *
 * These tests are event-driven (no timing waits): the relay caches each daemon frame BEFORE forwarding it,
 * so a watcher receiving a frame live proves it is cached; and the relay forwards `session.subscribe` to
 * the daemon AFTER replaying the cache, so the daemon receiving a subscribe is the "replay is done" barrier.
 */
const userId = 'user-cache';
const deviceId = 'device-cache';

const SESSION_FRAME_TYPES = ['session.key', 'session.started', 'agent.message', 'session.ended'];

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

/** Wait until the daemon receives the forwarded subscribe — by then the relay has replayed the cache. */
function awaitSubscribeForwarded(daemon: WebSocket): Promise<Envelope> {
  return waitForEnvelope(daemon, (e) => e.type === 'session.subscribe');
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('relay ciphertext cache (Phase 4 Task 8)', () => {
  it('replays a session’s cached ciphertext to a browser that subscribes (instant reopen)', async () => {
    const url = await startRelay();
    const sid = 'sess-replay';
    const daemon = await connectDaemon(url, userId, deviceId);
    sockets.push(daemon);

    // A first browser watches live; the relay caches each frame before forwarding, so a live receipt
    // proves the frame is now cached (the happens-before for the reopen below — no timing wait needed).
    const watcher = await connectBrowser(url, userId, deviceId);
    sockets.push(watcher);
    subscribe(watcher, sid);
    await awaitSubscribeForwarded(daemon); // the watcher is now an active subscriber
    daemonSend(daemon, 'session.key', sid, 'CIPHER_KEY');
    daemonSend(daemon, 'session.started', sid, 'CIPHER_STARTED');
    daemonSend(daemon, 'agent.message', sid, 'CIPHER_MSG');
    await waitForEnvelope(watcher, (e) => e.type === 'agent.message'); // received live ⇒ cached

    // A second browser reopens and subscribes → the relay replays the cached ciphertext immediately.
    const browser = await connectBrowser(url, userId, deviceId);
    sockets.push(browser);
    const got = collect(browser);
    subscribe(browser, sid);
    await waitForEnvelope(browser, (e) => e.type === 'agent.message'); // the replayed stream frame

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

    const watcher = await connectBrowser(url, userId, deviceId);
    sockets.push(watcher);
    subscribe(watcher, sid);
    await awaitSubscribeForwarded(daemon);
    for (let i = 0; i < 5; i += 1) daemonSend(daemon, 'agent.message', sid, `CIPHER_${i}`);
    // The last frame received live proves all five reached the cache (the ring keeps the last three).
    await waitForEnvelope(watcher, (e) => e.type === 'agent.message' && e.payload === 'CIPHER_4');

    const browser = await connectBrowser(url, userId, deviceId);
    sockets.push(browser);
    const got = collect(browser);
    subscribe(browser, sid);
    await waitForEnvelope(browser, (e) => e.type === 'agent.message' && e.payload === 'CIPHER_4');

    // Only the last 3 of the 5 streamed frames survive the ring; the oldest two were evicted.
    const payloads = got.filter((e) => e.type === 'agent.message').map((e) => e.payload);
    expect(payloads).toEqual(['CIPHER_2', 'CIPHER_3', 'CIPHER_4']);
  });

  it('replays nothing for an unknown session', async () => {
    const url = await startRelay();
    const daemon = await connectDaemon(url, userId, deviceId);
    sockets.push(daemon);
    const browser = await connectBrowser(url, userId, deviceId);
    sockets.push(browser);
    const got = collect(browser);

    subscribe(browser, 'never-seen');
    // Once the daemon sees the forwarded subscribe, the relay has already replayed any cache for it
    // (replay precedes the forward) — so nothing more will arrive for this never-cached session.
    await awaitSubscribeForwarded(daemon);
    expect(got.filter((e) => SESSION_FRAME_TYPES.includes(e.type))).toHaveLength(0);
  });
});
