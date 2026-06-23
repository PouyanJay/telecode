import { echoPayloadSchema, makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';

/**
 * Minimal browser-side relay client for the Phase 0 walking skeleton. Dials out to the relay,
 * announces itself as a `browser` for `(userId, deviceId)`, and round-trips an `echo`. The real
 * session client (subscribe/stream/permission decisions) is built in later phases.
 */
export interface RelayClientOptions {
  readonly relayUrl: string;
  readonly userId: string;
  readonly deviceId: string;
}

export interface RelayClient {
  connect(): Promise<void>;
  echo(text: string): Promise<string>;
  close(): void;
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  let socket: WebSocket | null = null;

  function send(envelope: Envelope): void {
    socket?.send(JSON.stringify(envelope));
  }

  return {
    connect(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(options.relayUrl);
        socket = ws;
        ws.addEventListener('open', () => {
          send(
            makeEnvelope({
              type: 'hello',
              userId: options.userId,
              deviceId: options.deviceId,
              payload: { role: 'browser' },
            }),
          );
        });
        ws.addEventListener('message', (event: MessageEvent) => {
          const envelope = parseEnvelope(JSON.parse(event.data as string));
          if (envelope.type === 'hello.ack') {
            resolve();
          }
        });
        ws.addEventListener('error', () => reject(new Error('relay connection error')));
      });
    },

    echo(text: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const ws = socket;
        if (ws === null) {
          reject(new Error('not connected'));
          return;
        }
        const onMessage = (event: MessageEvent): void => {
          const envelope = parseEnvelope(JSON.parse(event.data as string));
          if (envelope.type === 'echo.reply') {
            ws.removeEventListener('message', onMessage);
            resolve(echoPayloadSchema.parse(envelope.payload).text);
          }
        };
        ws.addEventListener('message', onMessage);
        send(
          makeEnvelope({
            type: 'echo',
            userId: options.userId,
            deviceId: options.deviceId,
            payload: { text },
          }),
        );
      });
    },

    close(): void {
      socket?.close();
      socket = null;
    },
  };
}
