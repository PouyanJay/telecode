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
  /** How long to wait for hello.ack / echo.reply before rejecting. */
  readonly timeoutMs?: number;
}

export interface RelayClient {
  connect(): Promise<void>;
  echo(text: string): Promise<string>;
  close(): void;
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const timeoutMs = options.timeoutMs ?? 5000;
  let socket: WebSocket | null = null;

  function send(envelope: Envelope): void {
    socket?.send(JSON.stringify(envelope));
  }

  return {
    connect(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(options.relayUrl);
        socket = ws;
        const timer = setTimeout(() => reject(new Error('relay connection timed out')), timeoutMs);
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
        ws.addEventListener('message', (event: MessageEvent<string>) => {
          if (parseEnvelope(JSON.parse(event.data)).type === 'hello.ack') {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('relay connection error'));
        });
      });
    },

    echo(text: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const ws = socket;
        if (ws === null) {
          reject(new Error('not connected'));
          return;
        }
        const onMessage = (event: MessageEvent<string>): void => {
          const envelope = parseEnvelope(JSON.parse(event.data));
          if (envelope.type === 'echo.reply') {
            clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            resolve(echoPayloadSchema.parse(envelope.payload).text);
          }
        };
        const timer = setTimeout(() => {
          ws.removeEventListener('message', onMessage);
          reject(new Error('echo timed out'));
        }, timeoutMs);
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
