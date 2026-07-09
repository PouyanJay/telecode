import {
  makeEnvelope,
  parseEnvelope,
  WS_CLOSE_UNAUTHORIZED,
  type Envelope,
} from '@telecode/protocol';
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
  /** Resolve on the next `hello` the daemon sends — i.e. its (re-)registration. */
  waitForHello(): Promise<void>;
  /** Drop the current daemon connection (simulates a transient network loss), forcing it to reconnect. */
  dropConnection(): void;
  /**
   * Simulate a HALF-OPEN link (laptop sleep / NAT rebind): pause the underlying socket so the relay
   * neither pongs the daemon's pings nor sends a `close`. The connection never fires `close` on its own —
   * only the daemon's OWN heartbeat watchdog can detect it and reconnect.
   */
  goSilentHalfOpen(): void;
  /** Reject subsequent `hello`s by closing with 4001 (simulates a revoked/invalid device token). */
  rejectHellos(): void;
  close(): Promise<void>;
}

export async function startFakeRelay(
  userId: string,
  deviceId: string,
  options: { rejectHello?: boolean } = {},
): Promise<FakeRelay> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake relay has no port');
  const url = `ws://127.0.0.1:${address.port}`;

  let socket: RelaySocket | null = null;
  let rejectHello = options.rejectHello ?? false;
  const buffered: Envelope[] = [];
  const waiters: { predicate: (e: Envelope) => boolean; resolve: (e: Envelope) => void }[] = [];
  let helloWaiters: (() => void)[] = [];

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
        if (rejectHello) {
          conn.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        conn.send(
          JSON.stringify(makeEnvelope({ type: 'hello.ack', userId, deviceId, payload: {} })),
        );
        // Notify anyone awaiting a (re-)registration.
        const pending = helloWaiters;
        helloWaiters = [];
        pending.forEach((w) => w());
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
    waitForHello(): Promise<void> {
      return new Promise<void>((resolve) => helloWaiters.push(resolve));
    },
    dropConnection(): void {
      socket?.close();
      socket = null;
    },
    goSilentHalfOpen(): void {
      // Pausing the underlying net socket stops the server from reading the daemon's ping frames, so no
      // auto-pong is generated — and no `close` is sent. The daemon must detect the silence on its own.
      // Reaches into `ws`'s internal `_socket`; assert it so a `ws` upgrade that moves it fails loudly here
      // rather than silently no-opping (which would surface as a confusing test timeout downstream).
      const raw = (socket as unknown as { _socket?: { pause(): void } })._socket;
      if (raw === undefined) throw new Error('fake relay: ws internals (_socket) unavailable');
      raw.pause();
    },
    rejectHellos(): void {
      rejectHello = true;
    },
    close(): Promise<void> {
      // Force-terminate every client first: a half-open (paused) socket left by `goSilentHalfOpen` never
      // closes on its own, and `server.close` waits for open connections — so without this it would hang.
      for (const client of server.clients) client.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Tell a daemon under test that a browser is watching its channel (relay `viewer.presence`), so its adopted-
 * session gate holds a consequential tool for a REMOTE decision instead of deferring to Claude Code's local
 * prompt. The echo round-trip is an in-order barrier: `viewer.presence` and `echo` travel the same socket, so
 * once the `echo.reply` returns the daemon has already applied the presence update — no timing wait.
 */
export async function markViewerPresent(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
): Promise<void> {
  relay.send(
    makeEnvelope({ type: 'viewer.presence', userId, deviceId, payload: { online: true } }),
  );
  relay.send(makeEnvelope({ type: 'echo', userId, deviceId, payload: { text: 'barrier' } }));
  await relay.waitForFrame((e) => e.type === 'echo.reply');
}
