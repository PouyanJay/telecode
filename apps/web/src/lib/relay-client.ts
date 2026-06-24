import {
  makeEnvelope,
  parseEnvelope,
  type Envelope,
  type PermissionDecisionPayload,
  type SessionLaunchPayload,
} from '@telecode/protocol';

/**
 * Browser-side relay connection. It dials out to the relay and authenticates the `hello` with a
 * short-lived channel token (minted by the web backend from the session cookie), then carries the
 * session transport: it launches a session, streams the daemon's frames back to the caller via
 * `onEvent`, and relays the human's permission decisions down. The relay assigns the `session_id` on
 * launch, so callers read it off the incoming frames rather than choosing it.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'error';

export interface RelayConnectionOptions {
  readonly relayUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly channelToken: string;
  readonly onStatus: (status: ConnectionStatus) => void;
  /** Every inbound session frame (everything except the `hello.ack` handshake). */
  readonly onEvent: (envelope: Envelope) => void;
}

export interface RelayConnection {
  /** Launch a new agent session on the watched device. The relay mints the `session_id`. */
  launch(payload: SessionLaunchPayload): void;
  /** Send the human's verdict for a pending `agent.permission_request` on `sessionId`. */
  decide(sessionId: string, decision: PermissionDecisionPayload): void;
  close(): void;
}

export function createRelayConnection(options: RelayConnectionOptions): RelayConnection {
  let socket: WebSocket | null = new WebSocket(options.relayUrl);
  options.onStatus('connecting');

  function send(
    type: 'session.launch' | 'permission.decision',
    payload: unknown,
    sessionId?: string,
  ): void {
    socket?.send(
      JSON.stringify(
        makeEnvelope({
          type,
          userId: options.userId,
          deviceId: options.deviceId,
          ...(sessionId !== undefined ? { sessionId } : {}),
          payload,
        }),
      ),
    );
  }

  socket.addEventListener('open', () => {
    socket?.send(
      JSON.stringify(
        makeEnvelope({
          type: 'hello',
          userId: options.userId,
          deviceId: options.deviceId,
          payload: { role: 'browser', token: options.channelToken },
        }),
      ),
    );
  });

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(JSON.parse(event.data) as unknown);
    } catch {
      return; // drop anything that isn't a valid envelope
    }
    if (envelope.type === 'hello.ack') {
      options.onStatus('connected');
      return;
    }
    options.onEvent(envelope);
  });

  socket.addEventListener('error', () => options.onStatus('error'));
  socket.addEventListener('close', () => options.onStatus('error'));

  return {
    launch(payload: SessionLaunchPayload): void {
      send('session.launch', payload);
    },
    decide(sessionId: string, decision: PermissionDecisionPayload): void {
      send('permission.decision', decision, sessionId);
    },
    close(): void {
      socket?.close();
      socket = null;
    },
  };
}
