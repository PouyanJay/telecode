import { makeEnvelope, parseEnvelope } from '@telecode/protocol';

/**
 * Browser-side relay connection. It dials out to the relay and authenticates the `hello` with a
 * short-lived channel token (minted by the web backend from the session cookie). Phase 1 reports
 * connection status; streaming session messages layer on in later tasks.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'error';

export interface RelayConnectionOptions {
  readonly relayUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly channelToken: string;
  readonly onStatus: (status: ConnectionStatus) => void;
}

export interface RelayConnection {
  close(): void;
}

export function createRelayConnection(options: RelayConnectionOptions): RelayConnection {
  let socket: WebSocket | null = new WebSocket(options.relayUrl);
  options.onStatus('connecting');

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
    if (parseEnvelope(JSON.parse(event.data) as unknown).type === 'hello.ack') {
      options.onStatus('connected');
    }
  });

  socket.addEventListener('error', () => options.onStatus('error'));
  socket.addEventListener('close', () => options.onStatus('error'));

  return {
    close(): void {
      socket?.close();
      socket = null;
    },
  };
}
