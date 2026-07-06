import {
  encodeKey,
  generateIdentityKeyPair,
  generateKeyPair,
  makeEnvelope,
} from '@telecode/protocol';
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
    getChannelToken: () => Promise.resolve('t'),
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

    // First connect + handshake (the hello is sent after the async token mint).
    sockets[0]!.fireOpen();
    await flush();
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
    await flush();
    expect(sockets[1]!.sentHello()).toBe(true);
    sockets[1]!.fireMessage(helloAck());
    await flush();
    expect(reconnects.count).toBe(1);

    conn.close();
  });

  it('mints a fresh channel token on each (re)connect (Phase 4 Task 4)', async () => {
    let minted = 0;
    const { sockets, conn } = connectWithFakes({
      getChannelToken: () => Promise.resolve(`token-${(minted += 1)}`),
    });

    // First connect carries the first token.
    sockets[0]!.fireOpen();
    await flush();
    expect(sockets[0]!.sent.some((f) => f.includes('token-1'))).toBe(true);
    sockets[0]!.fireMessage(helloAck());
    await flush();

    // After a drop, the reconnect re-mints rather than replaying the (possibly expired) first token.
    sockets[0]!.fireClose();
    await vi.advanceTimersByTimeAsync(11_000);
    sockets[1]!.fireOpen();
    await flush();
    expect(sockets[1]!.sent.some((f) => f.includes('token-2'))).toBe(true);

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

  it('holds session frames behind the handshake and releases them on hello.ack (ux Phase 5)', async () => {
    const { sockets, conn } = connectWithFakes();

    // Subscribed before the socket even opened (a per-device channel racing a page's subscribes):
    // nothing may be written into a CONNECTING/unauthenticated socket.
    conn.subscribe('sess-1');
    sockets[0]!.fireOpen();
    await flush();
    expect(sockets[0]!.sentHello()).toBe(true);
    expect(sockets[0]!.sent.some((f) => f.includes('session.subscribe'))).toBe(false);

    // The relay authenticates the peer → the queued frame flushes, in order, on the same socket.
    // (One extra flush: releasing the gate adds a microtask hop before the queued build runs.)
    sockets[0]!.fireMessage(helloAck());
    await flush();
    await flush();
    expect(sockets[0]!.sent.some((f) => f.includes('sess-1'))).toBe(true);

    // After a drop the gate re-arms: a frame enqueued mid-redial waits for the NEW handshake…
    sockets[0]!.fireClose();
    conn.subscribe('sess-2');
    await vi.advanceTimersByTimeAsync(11_000);
    sockets[1]!.fireOpen();
    await flush();
    expect(sockets[1]!.sent.some((f) => f.includes('sess-2'))).toBe(false);

    // …and is delivered only once the new socket is authenticated.
    sockets[1]!.fireMessage(helloAck());
    await flush();
    await flush();
    expect(sockets[1]!.sent.some((f) => f.includes('sess-2'))).toBe(true);

    conn.close();
  });

  it('a socket dying BEFORE its first hello.ack never wedges the send chain (gate rollover)', async () => {
    const { sockets, conn } = connectWithFakes();

    // A frame queued while the very first handshake is still pending…
    conn.subscribe('sess-early');
    sockets[0]!.fireOpen();
    await flush();
    // …and the socket dies before any hello.ack — the frame's gate generation is now orphaned
    // unless re-arming settles it. This exact race used to freeze the chain permanently: every
    // later send silently never went out.
    sockets[0]!.fireClose();
    await vi.advanceTimersByTimeAsync(11_000);

    // The redial authenticates cleanly; the early frame rolls over and flushes, as does a new one.
    sockets[1]!.fireOpen();
    await flush();
    sockets[1]!.fireMessage(helloAck());
    await flush();
    await flush();
    expect(sockets[1]!.sent.some((f) => f.includes('sess-early'))).toBe(true);

    conn.subscribe('sess-later');
    await flush();
    await flush();
    expect(sockets[1]!.sent.some((f) => f.includes('sess-later'))).toBe(true);

    conn.close();
  });
});

/**
 * Key self-healing (approval-reliability T1, web half): an encrypted frame for a session whose content
 * key this browser doesn't hold means the key was missed (e.g. the browser subscribed inside the
 * adopted-session announce window, before the daemon established the key). The client re-subscribes —
 * once per session until a key arrives — which makes the daemon deliver the key + an encrypted
 * backfill. Without this, the session stays undecryptable and a decision would go out CLEARTEXT into a
 * keyed daemon (the "dropped permission.decision" stuck-gate bug).
 */
describe('key self-healing: re-subscribe on a keyless encrypted frame', () => {
  // Real timers here (overriding the file-wide fake-timer setup): the subscribe send awaits native
  // WebCrypto keygen, which needs real event-loop turns — and nothing in these tests uses the backoff.
  beforeEach(() => {
    vi.useRealTimers();
  });

  const encryptedFrame = (sessionId: string): string =>
    JSON.stringify(
      makeEnvelope({
        type: 'agent.permission_request',
        userId: USER,
        deviceId: DEVICE,
        sessionId,
        payload: 'b64ciphertext',
        nonce: 'b64nonce',
      }),
    );

  const subscribesFor = (socket: FakeSocket, sessionId: string): number =>
    socket.sent.filter(
      (f) => f.includes('"session.subscribe"') && f.includes(`"session_id":"${sessionId}"`),
    ).length;

  it('re-subscribes exactly once per session until its key arrives', async () => {
    const daemonKp = await generateKeyPair();
    const { sockets, conn } = connectWithFakes({
      daemonPublicKey: encodeKey(daemonKp.publicKey),
      keyPairFactory: () => generateIdentityKeyPair(false),
    });
    const s = sockets[0]!;
    s.fireOpen();
    await flush();
    s.fireMessage(helloAck());
    await flush();

    s.fireMessage(encryptedFrame('sess-keyless'));
    // The subscribe send awaits the browser keypair (async) — flush the microtask chain generously.
    await vi.waitFor(() => expect(subscribesFor(s, 'sess-keyless')).toBe(1));

    // More keyless frames for the same session must NOT re-ask (no subscribe storm).
    s.fireMessage(encryptedFrame('sess-keyless'));
    s.fireMessage(encryptedFrame('sess-keyless'));
    await flush();
    await flush();
    expect(subscribesFor(s, 'sess-keyless')).toBe(1);

    // A different keyless session asks independently.
    s.fireMessage(encryptedFrame('sess-other'));
    await vi.waitFor(() => expect(subscribesFor(s, 'sess-other')).toBe(1));

    conn.close();
  });

  it('never re-subscribes for a cleartext frame (nothing to heal)', async () => {
    const daemonKp = await generateKeyPair();
    const e2e = connectWithFakes({
      daemonPublicKey: encodeKey(daemonKp.publicKey),
      keyPairFactory: () => generateIdentityKeyPair(false),
    });
    const s1 = e2e.sockets[0]!;
    s1.fireOpen();
    await flush();
    s1.fireMessage(helloAck());
    await flush();
    s1.fireMessage(
      JSON.stringify(
        makeEnvelope({
          type: 'agent.message',
          userId: USER,
          deviceId: DEVICE,
          sessionId: 'sess-clear',
          payload: { text: 'hi' },
        }),
      ),
    );
    await flush();
    await flush();
    expect(subscribesFor(s1, 'sess-clear')).toBe(0);
    e2e.conn.close();
  });

  it('never re-subscribes when E2E is off (there is no key to fetch)', async () => {
    const clear = connectWithFakes();
    const s2 = clear.sockets[0]!;
    s2.fireOpen();
    await flush();
    s2.fireMessage(helloAck());
    await flush();
    s2.fireMessage(encryptedFrame('sess-x'));
    await flush();
    await flush();
    expect(subscribesFor(s2, 'sess-x')).toBe(0);
    clear.conn.close();
  });
});
