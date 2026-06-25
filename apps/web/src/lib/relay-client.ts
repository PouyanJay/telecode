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
  /** Send an operator control (end / interrupt / pause / resume) for `sessionId`. */
  control(sessionId: string, action: SessionControlAction): void;
  close(): void;
}

export function createRelayConnection(options: RelayConnectionOptions): RelayConnection {
  let socket: WebSocket | null = new WebSocket(options.relayUrl);
  options.onStatus('connecting');
  const cipher = createBrowserSessionCipher(options.daemonPublicKey);

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

  socket.addEventListener('open', () => {
    // The handshake is cleartext: the relay must read the role + channel token to authenticate the peer.
    socket?.send(
      buildFrame('hello', { payload: { role: 'browser', token: options.channelToken } }),
    );
  });

  // Inbound frames are handled in order through a chain (decryption is async): the `session.key` that
  // unlocks a session must be applied before the encrypted frames that follow it.
  let inbound: Promise<void> = Promise.resolve();
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    // A failed frame (e.g. a decryption error from a key mismatch) surfaces as a connection error rather
    // than silently dropping — consistent with the send chain's handler.
    inbound = inbound.then(() => handleFrame(event.data)).catch(() => options.onStatus('error'));
  });

  async function handleFrame(data: string): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(JSON.parse(data) as unknown);
    } catch {
      return; // drop anything that isn't a valid envelope
    }
    if (envelope.type === 'hello.ack') {
      options.onStatus('connected');
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

  socket.addEventListener('error', () => options.onStatus('error'));
  socket.addEventListener('close', () => options.onStatus('error'));

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
      socket?.close();
      socket = null;
    },
  };
}
