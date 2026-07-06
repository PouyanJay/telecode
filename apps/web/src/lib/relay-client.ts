import {
  adoptStatePayloadSchema,
  makeEnvelope,
  parseEnvelope,
  type AdoptSettings,
  type AdoptStatePayload,
  type Envelope,
  type MessageType,
  type HandoverAnswerPayload,
  type PermissionDecisionPayload,
  type QuestionAnswerPayload,
  type SessionControlAction,
  type SessionLaunchPayload,
} from '@telecode/protocol';

import { createBrowserSessionCipher } from './session-cipher';

/**
 * Browser-side relay connection. It dials out to the relay and authenticates the `hello` with a
 * short-lived channel token (minted by the web backend from the session cookie), then carries the
 * session transport: it launches a session, streams the daemon's frames back to the caller via
 * `onEvent`, and relays the human's permission decisions down. The relay assigns the `session_id` on
 * launch, so callers read it off the incoming frames rather than choosing it.
 *
 * End-to-end encryption (Phase 3): when this connection's device registered a public key, every session payload
 * is sealed before it leaves the browser and opened after it arrives — the relay only ever forwards
 * ciphertext. The launch is box-sealed to the daemon; the daemon delivers a per-session content key
 * (`session.key`) that encrypts the rest. Crypto lives in {@link createBrowserSessionCipher}; this module
 * only sequences send/receive so async (de)encryption never reorders the stream.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'error';

export interface RelayConnectionOptions {
  readonly relayUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  /**
   * Mint a short-lived channel token to authenticate the `hello`. Called on the first connect AND on every
   * reconnect, so a token that expired during a long sleep is re-minted rather than replayed (Phase 4
   * Task 4) — otherwise the relay would reject the reconnect (4001) and the client would loop forever.
   */
  readonly getChannelToken: () => Promise<string>;
  /** This connection's device X25519 public key (base64) for E2E; null/undefined keeps the channel cleartext. */
  readonly daemonPublicKey?: string | null;
  /** Test seam: the browser identity keypair source (defaults to the IndexedDB-persisted identity). */
  readonly keyPairFactory?: Parameters<typeof createBrowserSessionCipher>[1];
  readonly onStatus: (status: ConnectionStatus) => void;
  /** Every inbound session frame (everything except the `hello.ack` handshake and `session.key`). */
  readonly onEvent: (envelope: Envelope) => void;
  /**
   * Called once a *reconnect* (not the first connect) re-authenticates — i.e. a fresh `hello.ack` after a
   * dropped socket. The caller reattaches its sessions here (resubscribe → daemon backfill), since the
   * relay/daemon treat a reconnect as a reopen (architecture invariant #7).
   */
  readonly onReconnect?: () => void;
  /** The daemon's current adoption policy (sealed `adopt.state`), surfaced for the Settings UI (Journey 3). */
  readonly onAdoptState?: (state: AdoptStatePayload) => void;
  /**
   * Seam for building the underlying socket. Production uses a real browser `WebSocket`; tests inject a
   * controllable fake (the web Vitest runs in node, where there is no DOM `WebSocket`).
   */
  readonly createSocket?: (url: string) => WebSocket;
}

export interface RelayConnection {
  /** Launch a new agent session on this connection's device. The relay mints the `session_id`. */
  launch(payload: SessionLaunchPayload): void;
  /** Re-attach to an existing session on reopen; the daemon replies with `session.history` (backfill). */
  subscribe(sessionId: string): void;
  /** Send a follow-up instruction to steer an existing session (resumes its agent conversation). */
  sendUserMessage(sessionId: string, text: string): void;
  /** Send the human's verdict for a pending `agent.permission_request` on `sessionId`. */
  decide(sessionId: string, decision: PermissionDecisionPayload): void;
  /** Send the human's answer to a pending `agent.question` on `sessionId` (adopted-session questions). */
  answer(sessionId: string, payload: QuestionAnswerPayload): void;
  /**
   * Take over a pending `agent.handover` on `sessionId` (Journey 4): the daemon forks-and-resumes the
   * adopted conversation with this answer, migrating it to a telecode-owned continuation.
   */
  answerHandover(sessionId: string, payload: HandoverAnswerPayload): void;
  /** Send an operator control (interrupt / end) for `sessionId`. */
  control(sessionId: string, action: SessionControlAction): void;
  /**
   * Seal a rename title `{ title }` under `sessionId`'s content key, for the REST rename path (ux Phase 6
   * T6). Returns the wire blob + nonce, or `null` when the session isn't E2E (no content key) — rename is
   * only offered for encrypted sessions, so the relay's opaque `sealed_title` is always real ciphertext.
   */
  sealTitle(sessionId: string, title: string): Promise<{ payload: string; nonce: string } | null>;
  /**
   * Read (`set` omitted) or update (`set` provided) the device's adoption policy. Box-sealed to the daemon
   * so the relay never sees repo paths; the daemon replies `adopt.state` via `onAdoptState` (Journey 3).
   */
  sendAdoptConfig(set?: AdoptSettings): void;
  close(): void;
}

export function createRelayConnection(options: RelayConnectionOptions): RelayConnection {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const getChannelToken = options.getChannelToken;
  const cipher = options.keyPairFactory
    ? createBrowserSessionCipher(options.daemonPublicKey, options.keyPairFactory)
    : createBrowserSessionCipher(options.daemonPublicKey);
  let socket: WebSocket | null = null;
  // Reconnect state: an unexpected drop auto-redials (reopen is a reconnect — architecture invariant #7);
  // an intentional close() does not. `hasConnected` distinguishes the first handshake from a reconnect so
  // the caller only reattaches sessions on the latter.
  let intentionallyClosed = false;
  let hasConnected = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const BASE_RECONNECT_MS = 500;
  const MAX_RECONNECT_MS = 10_000;

  function buildFrame(
    type: MessageType,
    opts: { sessionId?: string; payload: unknown; nonce?: string; senderPublicKey?: string },
  ): string {
    return JSON.stringify(
      makeEnvelope({
        type,
        userId: options.userId,
        deviceId: options.deviceId,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.senderPublicKey !== undefined ? { senderPublicKey: opts.senderPublicKey } : {}),
        payload: opts.payload,
        nonce: opts.nonce ?? '',
      }),
    );
  }

  // Handshake gate: outbound session frames must never race the `hello` — a frame sent while the
  // socket is still CONNECTING throws (and is lost), and one sent before the relay authenticated
  // this peer is silently ignored server-side. The gate opens on `hello.ack` and re-arms the moment
  // the socket dies, so frames enqueued during a redial simply wait for the next handshake. (With
  // one channel per device — ux Phase 5 — a page's subscribes routinely race the slower handshakes.)
  // Re-arming must SETTLE the generation it replaces: a socket that dies before its `hello.ack`
  // leaves waiters bound to that specific promise, and an orphaned (never-settled) one would wedge
  // the send chain — silently, forever. Rejecting the outgoing generation lets waiters ROLL OVER to
  // the next one (see handshakeSettled), so frames queued during a failed dial still go out, in
  // order, once a later handshake succeeds. Rejecting is a no-op when the gate already opened.
  let openHandshakeGate: () => void = () => undefined;
  let rejectHandshakeGate: (reason: Error) => void = () => undefined;
  let handshakeDone: Promise<void> = new Promise((resolve, reject) => {
    openHandshakeGate = resolve;
    rejectHandshakeGate = reject;
  });
  function armHandshakeGate(): void {
    // Muffle first: the outgoing generation may have no waiters, and an unobserved rejection must
    // not surface as an unhandled-rejection crash.
    handshakeDone.catch(() => undefined);
    rejectHandshakeGate(new Error('The socket closed before its handshake completed.'));
    handshakeDone = new Promise((resolve, reject) => {
      openHandshakeGate = resolve;
      rejectHandshakeGate = reject;
    });
  }

  /**
   * Resolve once ANY handshake completes: a generation that dies mid-dial re-arms the gate, and
   * waiters simply move onto the new generation — an intentionally-closed connection just never
   * settles (its queue is moot). Throws only in the unreachable no-new-generation case.
   */
  async function handshakeSettled(): Promise<void> {
    for (;;) {
      const gate = handshakeDone;
      try {
        await gate;
        return;
      } catch (err) {
        if (handshakeDone === gate) throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  // Outbound frames are built asynchronously (sealing is async), so serialize them to preserve order.
  let sendChain: Promise<void> = Promise.resolve();
  function enqueueSend(build: () => Promise<string>): void {
    sendChain = sendChain
      .then(async () => {
        await handshakeSettled();
        const frame = await build();
        socket?.send(frame);
      })
      .catch(() => options.onStatus('error'));
  }

  /** Build a browser→daemon session frame, sealing its payload under the content key when E2E is active. */
  async function sessionFrame(
    type: MessageType,
    sessionId: string,
    payload: unknown,
  ): Promise<string> {
    if (cipher.isEncrypted(sessionId)) {
      const sealed = await cipher.encrypt(sessionId, payload);
      return buildFrame(type, { sessionId, payload: sealed.payload, nonce: sealed.nonce });
    }
    return buildFrame(type, { sessionId, payload });
  }

  // Sessions with a key re-request in flight (self-healing): asked once, cleared when the key lands.
  const pendingKeyRequests = new Set<string>();

  /** Subscribe to a session, announcing this browser's pubkey so the daemon (re-)delivers its key. */
  function sendSubscribe(sessionId: string): void {
    enqueueSend(async () => {
      // Subscribe stays cleartext (`{}`) — it carries no secret — but announces the browser pubkey so
      // the daemon re-delivers the content key for this (possibly reopened) browser.
      const senderPublicKey = await cipher.publicKey();
      return buildFrame('session.subscribe', {
        sessionId,
        payload: {},
        ...(senderPublicKey !== undefined ? { senderPublicKey } : {}),
      });
    });
  }

  /** Dial the relay and wire one socket's lifecycle. Called on first connect and on every reconnect. */
  function openSocket(): void {
    const ws = createSocket(options.relayUrl);
    socket = ws;
    options.onStatus('connecting');

    ws.addEventListener('open', () => {
      // The handshake is cleartext: the relay must read the role + channel token to authenticate the peer.
      // Mint the token now (per connect), so a reconnect after a long sleep gets a fresh, unexpired one.
      void (async () => {
        try {
          const token = await getChannelToken();
          ws.send(buildFrame('hello', { payload: { role: 'browser', token } }));
        } catch {
          // Couldn't mint a token (e.g. the cookie lapsed): surface it and close so the reconnect loop
          // retries — a transient token-endpoint failure shouldn't permanently wedge the channel.
          options.onStatus('error');
          ws.close();
        }
      })();
    });

    // Inbound frames are handled in order through a chain (decryption is async): the `session.key` that
    // unlocks a session must be applied before the encrypted frames that follow it. Each socket gets its
    // own chain; the cipher + outbound chain persist across reconnects so keys and order survive a redial.
    let inbound: Promise<void> = Promise.resolve();
    ws.addEventListener('message', (event: MessageEvent<string>) => {
      // A failed frame (e.g. a decryption error from a key mismatch) surfaces as a connection error rather
      // than silently dropping — consistent with the send chain's handler.
      inbound = inbound.then(() => handleFrame(event.data)).catch(() => options.onStatus('error'));
    });

    ws.addEventListener('error', () => options.onStatus('error'));
    ws.addEventListener('close', () => {
      // The socket died: close the gate so frames enqueued from here on wait for the NEXT
      // handshake instead of being written into a dead (or not-yet-authenticated) socket.
      armHandshakeGate();
      // An intentional close() is terminal; an unexpected drop schedules a transparent redial.
      if (intentionallyClosed) return;
      scheduleReconnect();
    });
  }

  /** Schedule a redial with exponential backoff + jitter (capped), unless the link was torn down. */
  function scheduleReconnect(): void {
    if (intentionallyClosed || reconnectTimer !== null) return;
    const ceiling = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** reconnectAttempts);
    const delay = ceiling / 2 + Math.random() * (ceiling / 2); // full-jitter half-range
    reconnectAttempts += 1;
    options.onStatus('connecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  async function handleFrame(data: string): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(JSON.parse(data) as unknown);
    } catch {
      return; // drop anything that isn't a valid envelope
    }
    if (envelope.type === 'hello.ack') {
      reconnectAttempts = 0;
      const reconnected = hasConnected;
      hasConnected = true;
      // The relay has authenticated this peer — release any session frames queued behind the gate.
      openHandshakeGate();
      options.onStatus('connected');
      // On a *reconnect* (not the first handshake) the caller reattaches its sessions (resubscribe →
      // backfill), since the daemon treats this as a reopen.
      if (reconnected) options.onReconnect?.();
      return;
    }
    if (envelope.type === 'session.key') {
      // Transport message: store the content key, never surface it to the UI.
      await cipher.receiveKey(envelope);
      // The key landed — a future loss for this session may self-heal again (see below).
      if (envelope.session_id !== undefined) pendingKeyRequests.delete(envelope.session_id);
      return;
    }
    if (envelope.type === 'adopt.state') {
      // Device-scoped, sealed to THIS browser (Journey 3) — opened with the device key, not a session key.
      try {
        const raw = cipher.enabled ? await cipher.openFromDaemon(envelope) : envelope.payload;
        options.onAdoptState?.(adoptStatePayloadSchema.parse(raw));
      } catch {
        // Ignore: most often a state sealed to a DIFFERENT browser (the relay broadcasts it to the channel),
        // which we can't open — the browser that asked gets one it can, and others re-request on mount. A
        // genuine schema mismatch (daemon version skew) also lands here; it surfaces as the Settings panel
        // staying on its loading state rather than a thrown error, which is acceptable for a rare edge.
      }
      return;
    }
    const result = await cipher.tryDecrypt(envelope);
    const sessionId = envelope.session_id;
    if (!result.decrypted && sessionId !== undefined && needsKeyRecovery(envelope, sessionId)) {
      pendingKeyRequests.add(sessionId);
      sendSubscribe(sessionId);
    }
    options.onEvent(result.decrypted ? { ...envelope, payload: result.payload } : envelope);
  }

  /**
   * Key self-healing: an ENCRYPTED frame we hold no key for means the session's key was missed (the
   * classic case: this browser subscribed inside the adopted-session announce window, before the
   * daemon established the key). Re-subscribe — once per session until a key arrives — so the daemon
   * re-delivers the key and an encrypted backfill. Without this the session stays undecryptable and
   * a decision would go out cleartext into a keyed daemon, which drops it (a stuck gate).
   */
  function needsKeyRecovery(envelope: Envelope, sessionId: string): boolean {
    return (
      cipher.enabled &&
      envelope.nonce !== '' &&
      typeof envelope.payload === 'string' &&
      !pendingKeyRequests.has(sessionId)
    );
  }

  openSocket();

  return {
    launch(payload: SessionLaunchPayload): void {
      enqueueSend(async () => {
        if (cipher.enabled) {
          const sealed = await cipher.sealLaunch(payload);
          return buildFrame('session.launch', {
            payload: sealed.payload,
            nonce: sealed.nonce,
            senderPublicKey: sealed.senderPublicKey,
          });
        }
        return buildFrame('session.launch', { payload });
      });
    },
    subscribe(sessionId: string): void {
      sendSubscribe(sessionId);
    },
    sendUserMessage(sessionId: string, text: string): void {
      enqueueSend(() => sessionFrame('user.message', sessionId, { text }));
    },
    decide(sessionId: string, decision: PermissionDecisionPayload): void {
      enqueueSend(() => sessionFrame('permission.decision', sessionId, decision));
    },
    answer(sessionId: string, payload: QuestionAnswerPayload): void {
      enqueueSend(() => sessionFrame('question.answer', sessionId, payload));
    },
    answerHandover(sessionId: string, payload: HandoverAnswerPayload): void {
      enqueueSend(() => sessionFrame('handover.answer', sessionId, payload));
    },
    control(sessionId: string, action: SessionControlAction): void {
      enqueueSend(() => sessionFrame('session.control', sessionId, { action }));
    },
    async sealTitle(
      sessionId: string,
      title: string,
    ): Promise<{ payload: string; nonce: string } | null> {
      // Gated to E2E sessions: no content key → no rename (the caller reports that honestly rather than
      // sending a fake blob). `cipher.encrypt` always yields a string ciphertext payload + non-empty nonce.
      if (!cipher.isEncrypted(sessionId)) return null;
      const sealed = await cipher.encrypt(sessionId, { title });
      return { payload: sealed.payload, nonce: sealed.nonce };
    },
    sendAdoptConfig(set?: AdoptSettings): void {
      enqueueSend(async () => {
        const payload = set !== undefined ? { set } : {};
        if (cipher.enabled) {
          // Seal to the daemon + announce our pubkey so it can seal the adopt.state reply back to us.
          const sealed = await cipher.sealToDaemon(payload);
          return buildFrame('adopt.config', {
            payload: sealed.payload,
            nonce: sealed.nonce,
            senderPublicKey: sealed.senderPublicKey,
          });
        }
        return buildFrame('adopt.config', { payload });
      });
    },
    close(): void {
      intentionallyClosed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}
