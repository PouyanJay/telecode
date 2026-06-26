import {
  makeEnvelope,
  parseEnvelope,
  type Envelope,
  type MessageType,
  type PermissionDecisionPayload,
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
 * End-to-end encryption (Phase 3): when the watched device registered a public key, every session payload
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
  readonly channelToken: string;
  /** The watched device's X25519 public key (base64) for E2E; null/undefined keeps the channel cleartext. */
  readonly daemonPublicKey?: string | null;
  readonly onStatus: (status: ConnectionStatus) => void;
  /** Every inbound session frame (everything except the `hello.ack` handshake and `session.key`). */
  readonly onEvent: (envelope: Envelope) => void;
  /**
   * Called once a *reconnect* (not the first connect) re-authenticates — i.e. a fresh `hello.ack` after a
   * dropped socket. The caller reattaches its sessions here (resubscribe → daemon backfill), since the
   * relay/daemon treat a reconnect as a reopen (architecture invariant #7).
   */
  readonly onReconnect?: () => void;
  /**
   * Seam for building the underlying socket. Production uses a real browser `WebSocket`; tests inject a
   * controllable fake (the web Vitest runs in node, where there is no DOM `WebSocket`).
   */
  readonly createSocket?: (url: string) => WebSocket;
}

export interface RelayConnection {
  /** Launch a new agent session on the watched device. The relay mints the `session_id`. */
  launch(payload: SessionLaunchPayload): void;
  /** Re-attach to an existing session on reopen; the daemon replies with `session.history` (backfill). */
  subscribe(sessionId: string): void;
  /** Send a follow-up instruction to steer an existing session (resumes its agent conversation). */
  sendUserMessage(sessionId: string, text: string): void;
  /** Send the human's verdict for a pending `agent.permission_request` on `sessionId`. */
  decide(sessionId: string, decision: PermissionDecisionPayload): void;
  /** Send an operator control (interrupt / end) for `sessionId`. */
  control(sessionId: string, action: SessionControlAction): void;
  close(): void;
}

export function createRelayConnection(options: RelayConnectionOptions): RelayConnection {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const cipher = createBrowserSessionCipher(options.daemonPublicKey);
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

  // Outbound frames are built asynchronously (sealing is async), so serialize them to preserve order.
  let sendChain: Promise<void> = Promise.resolve();
  function enqueueSend(build: () => Promise<string>): void {
    sendChain = sendChain
      .then(async () => {
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

  /** Dial the relay and wire one socket's lifecycle. Called on first connect and on every reconnect. */
  function openSocket(): void {
    const ws = createSocket(options.relayUrl);
    socket = ws;
    options.onStatus('connecting');

    ws.addEventListener('open', () => {
      // The handshake is cleartext: the relay must read the role + channel token to authenticate the peer.
      ws.send(buildFrame('hello', { payload: { role: 'browser', token: options.channelToken } }));
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
      options.onStatus('connected');
      // On a *reconnect* (not the first handshake) the caller reattaches its sessions (resubscribe →
      // backfill), since the daemon treats this as a reopen.
      if (reconnected) options.onReconnect?.();
      return;
    }
    if (envelope.type === 'session.key') {
      // Transport message: store the content key, never surface it to the UI.
      await cipher.receiveKey(envelope);
      return;
    }
    const result = await cipher.tryDecrypt(envelope);
    options.onEvent(result.decrypted ? { ...envelope, payload: result.payload } : envelope);
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
    },
    sendUserMessage(sessionId: string, text: string): void {
      enqueueSend(() => sessionFrame('user.message', sessionId, { text }));
    },
    decide(sessionId: string, decision: PermissionDecisionPayload): void {
      enqueueSend(() => sessionFrame('permission.decision', sessionId, decision));
    },
    control(sessionId: string, action: SessionControlAction): void {
      enqueueSend(() => sessionFrame('session.control', sessionId, { action }));
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
