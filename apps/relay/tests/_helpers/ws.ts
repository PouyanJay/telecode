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

    function onMessage(raw: WebSocket.RawData): void {
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

/** Open a browser-role connection to the relay and wait until it is registered (hello.ack). */
export async function connectBrowser(
  relayUrl: string,
  userId: string,
  deviceId: string,
): Promise<WebSocket> {
  const socket = new WebSocket(relayUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const ack = waitForEnvelope(socket, (e) => e.type === 'hello.ack');
  socket.send(
    JSON.stringify(makeEnvelope({ type: 'hello', userId, deviceId, payload: { role: 'browser' } })),
  );
  await ack;
  return socket;
}

/** Send an `echo` from a connected browser socket. */
export function sendEcho(socket: WebSocket, userId: string, deviceId: string, text: string): void {
  socket.send(JSON.stringify(makeEnvelope({ type: 'echo', userId, deviceId, payload: { text } })));
}
