import { makeEnvelope } from '@telecode/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRelayConnection, type ConnectionStatus } from './relay-client';

/**
 * Phase 4 Task 1 (walking skeleton) — browser auto-reconnect. When the relay socket drops unexpectedly
 * the connection must transparently redial, re-`hello` to re-authenticate, and (on the fresh `hello.ack`)
 * fire `onReconnect` so the caller reattaches its sessions — no page reload. An *intentional* `close()`
 * must NOT reconnect. Driven through an injected fake socket (the web Vitest runs in node, no DOM
 * `WebSocket`), with fake timers for the reconnect backoff.
 */
const USER = 'u';
const DEVICE = 'd';

/** A controllable fake WebSocket: records sent frames and lets the test fire open/message/close. */
function makeFakeSocket() {
  const sent: string[] = [];
  const listeners: Record<'open' | 'message' | 'error' | 'close', ((arg?: unknown) => void)[]> = {
    open: [],
    message: [],
    error: [],
    close: [],
  };
  let closed = false;
  return {
    sent,
    isClosed: (): boolean => closed,
    send: (data: string): void => {
      sent.push(data);
    },
    close: (): void => {
      closed = true;
    },
    addEventListener: (
      type: 'open' | 'message' | 'error' | 'close',
      cb: (arg?: unknown) => void,
    ): void => {
      listeners[type].push(cb);
    },
    fireOpen: (): void => listeners.open.forEach((cb) => cb()),
    fireMessage: (data: string): void => listeners.message.forEach((cb) => cb({ data })),
    fireClose: (): void => listeners.close.forEach((cb) => cb()),
    sentHello: (): boolean => sent.some((f) => f.includes('"hello"')),
  };
}

type FakeSocket = ReturnType<typeof makeFakeSocket>;

const helloAck = (): string =>
  JSON.stringify(makeEnvelope({ type: 'hello.ack', userId: USER, deviceId: DEVICE, payload: {} }));

/** Flush the inbound microtask chain (handleFrame is async). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function connectWithFakes(overrides: Partial<Parameters<typeof createRelayConnection>[0]> = {}): {
  sockets: FakeSocket[];
  statuses: ConnectionStatus[];
  reconnects: { count: number };
  conn: ReturnType<typeof createRelayConnection>;
} {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const reconnects = { count: 0 };
  const conn = createRelayConnection({
    relayUrl: 'ws://relay/ws',
    userId: USER,
    deviceId: DEVICE,
    channelToken: 't',
    onStatus: (s) => statuses.push(s),
    onEvent: () => undefined,
    onReconnect: () => {
      reconnects.count += 1;
    },
    createSocket: () => {
      const s = makeFakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    ...overrides,
  });
  return { sockets, statuses, reconnects, conn };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('relay-client auto-reconnect (Phase 4 Task 1)', () => {
  it('redials and re-authenticates after an unexpected drop, then fires onReconnect', async () => {
    const { sockets, statuses, reconnects, conn } = connectWithFakes();

    // First connect + handshake.
    sockets[0]!.fireOpen();
    expect(sockets[0]!.sentHello()).toBe(true);
    sockets[0]!.fireMessage(helloAck());
    await flush();
    expect(statuses).toContain('connected');
    expect(reconnects.count).toBe(0);

    // The socket drops unexpectedly → the client schedules a redial.
    sockets[0]!.fireClose();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(sockets.length).toBe(2); // a brand-new socket was dialed

    // Re-handshake on the new socket → connected again + onReconnect (caller reattaches sessions).
    sockets[1]!.fireOpen();
    expect(sockets[1]!.sentHello()).toBe(true);
    sockets[1]!.fireMessage(helloAck());
    await flush();
    expect(reconnects.count).toBe(1);

    conn.close();
  });

  it('does not reconnect after an intentional close()', async () => {
    const { sockets, conn } = connectWithFakes();
    sockets[0]!.fireOpen();
    sockets[0]!.fireMessage(helloAck());
    await flush();

    conn.close();
    sockets[0]!.fireClose(); // a close() also surfaces the socket's close event
    await vi.advanceTimersByTimeAsync(11_000);
    expect(sockets.length).toBe(1); // no redial after an intentional teardown
  });
});
