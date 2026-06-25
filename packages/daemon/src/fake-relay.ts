import { makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';
import { WebSocketServer, type WebSocket as RelaySocket } from 'ws';

/**
 * Test-only helper (not part of the package's public API): a minimal in-process stand-in for the relay
 * so a real {@link createDaemon} can be driven over a real WebSocket. It acks `hello`, ferries frames to
 * the daemon under test, and lets a test await a specific frame the daemon emits. Frames are consumed on
 * match (each `waitForFrame` returns a distinct frame) so a session that ends more than once — e.g. a
 * turn then a follow-up — can be awaited in sequence.
 */
export interface FakeRelay {
  readonly url: string;
  send(envelope: Envelope): void;
  waitForFrame(predicate: (e: Envelope) => boolean): Promise<Envelope>;
  close(): Promise<void>;
}

export async function startFakeRelay(userId: string, deviceId: string): Promise<FakeRelay> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake relay has no port');
  const url = `ws://127.0.0.1:${address.port}`;

  let socket: RelaySocket | null = null;
  const buffered: Envelope[] = [];
  const waiters: { predicate: (e: Envelope) => boolean; resolve: (e: Envelope) => void }[] = [];

  function deliver(envelope: Envelope): void {
    const index = waiters.findIndex((w) => w.predicate(envelope));
    if (index >= 0) waiters.splice(index, 1)[0]?.resolve(envelope);
    else buffered.push(envelope);
  }

  server.on('connection', (conn: RelaySocket) => {
    socket = conn;
    conn.on('message', (raw: Buffer) => {
      let envelope: Envelope;
      try {
        envelope = parseEnvelope(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (envelope.type === 'hello') {
        conn.send(
          JSON.stringify(makeEnvelope({ type: 'hello.ack', userId, deviceId, payload: {} })),
        );
        return;
      }
      deliver(envelope);
    });
  });

  return {
    url,
    send(envelope: Envelope): void {
      if (!socket) throw new Error('fake relay: daemon not connected yet');
      socket.send(JSON.stringify(envelope));
    },
    waitForFrame(predicate): Promise<Envelope> {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0] as Envelope);
      return new Promise<Envelope>((resolve, reject) => {
        // Event-driven; the 5s deadline is only an abort guard on real WS I/O (matches AD-P2-6).
        const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), 5000);
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
