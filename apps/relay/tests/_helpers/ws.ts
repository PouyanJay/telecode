import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import WebSocket from 'ws';

/** Resolve with the first envelope a socket receives that matches `predicate`; reject on timeout. */
export function waitForEnvelope(
  socket: WebSocket,
  predicate: (envelope: Envelope) => boolean,
  timeoutMs = 5000,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('timed out waiting for envelope'));
    }, timeoutMs);

    function onMessage(raw: Buffer): void {
      const envelope = parseEnvelope(JSON.parse(raw.toString()));
      if (predicate(envelope)) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(envelope);
      }
    }

    socket.on('message', onMessage);
  });
}

/**
 * Open a browser-role connection to the relay and wait until it is registered (hello.ack) AND its
 * mandatory `device.presence` snapshot has been drained. The relay answers every browser hello with
 * exactly one presence snapshot (honesty pass T2); draining it here — like the ack — means no test has
 * to expect it in its own frame assertions, and no frame is lost in the gap between the handshake and
 * the caller attaching its listeners. When the relay enforces auth, pass the short-lived channel
 * `token` to authenticate the `hello`.
 */
export async function connectBrowser(
  relayUrl: string,
  userId: string,
  deviceId: string,
  token?: string,
): Promise<WebSocket> {
  const socket = new WebSocket(relayUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const ack = waitForEnvelope(socket, (e) => e.type === 'hello.ack');
  const presenceSnapshot = waitForEnvelope(socket, (e) => e.type === 'device.presence');
  socket.send(
    JSON.stringify(
      makeEnvelope({
        type: 'hello',
        userId,
        deviceId,
        payload: { role: 'browser', ...(token !== undefined ? { token } : {}) },
      }),
    ),
  );
  await Promise.all([ack, presenceSnapshot]);
  return socket;
}

/** Send an `echo` from a connected browser socket. */
export function sendEcho(socket: WebSocket, userId: string, deviceId: string, text: string): void {
  socket.send(JSON.stringify(makeEnvelope({ type: 'echo', userId, deviceId, payload: { text } })));
}

/**
 * Open a daemon-role connection to the relay and wait until it is registered (hello.ack). When the relay
 * enforces device auth, pass the device `token` to authenticate the `hello`. Mirrors {@link connectBrowser}
 * for tests that need both ends of a channel (e.g. an end-to-end encrypted round-trip).
 */
export async function connectDaemon(
  relayUrl: string,
  userId: string,
  deviceId: string,
  token?: string,
): Promise<WebSocket> {
  const socket = new WebSocket(relayUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const ack = waitForEnvelope(socket, (e) => e.type === 'hello.ack');
  socket.send(
    JSON.stringify(
      makeEnvelope({
        type: 'hello',
        userId,
        deviceId,
        payload: { role: 'daemon', ...(token !== undefined ? { token } : {}) },
      }),
    ),
  );
  await ack;
  return socket;
}
