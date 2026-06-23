import { pino, type Logger } from 'pino';
import WebSocket from 'ws';

import { echoPayloadSchema, makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';

/**
 * The local daemon: it dials *out* to the relay (laptops sit behind NAT — nothing ever
 * reaches in), announces itself for `(userId, deviceId)`, and supervises work for that
 * device. Phase 0 only answers `echo` to prove the outbound-relay path end-to-end; the
 * Claude Agent SDK adapter lands in a later task.
 */
export interface DaemonOptions {
  readonly relayUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly logger?: Logger;
}

export interface Daemon {
  /** Connect to the relay and resolve once the relay has acknowledged registration. */
  start(): Promise<void>;
  /** Close the connection. */
  stop(): Promise<void>;
}

export function createDaemon(options: DaemonOptions): Daemon {
  const log = options.logger ?? pino({ name: 'daemon' });
  let socket: WebSocket | null = null;

  function handleMessage(raw: Buffer, onReady: () => void): void {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(JSON.parse(raw.toString()));
    } catch (err) {
      log.warn({ err }, 'daemon: dropped invalid envelope');
      return;
    }

    switch (envelope.type) {
      case 'hello.ack': {
        log.info({ device: options.deviceId }, 'daemon: registered with relay');
        onReady();
        return;
      }
      case 'echo': {
        const echo = echoPayloadSchema.safeParse(envelope.payload);
        if (!echo.success) {
          log.warn({ device: options.deviceId }, 'daemon: dropped echo with invalid payload');
          return;
        }
        const { text } = echo.data;
        log.info({ device: options.deviceId, text }, 'daemon: echo received');
        socket?.send(
          JSON.stringify(
            makeEnvelope({
              type: 'echo.reply',
              userId: envelope.user_id,
              deviceId: envelope.device_id,
              ...(envelope.session_id !== undefined ? { sessionId: envelope.session_id } : {}),
              payload: { text },
            }),
          ),
        );
        return;
      }
      default:
        log.debug({ type: envelope.type }, 'daemon: ignoring message');
    }
  }

  return {
    async start(): Promise<void> {
      const ws = new WebSocket(options.relayUrl);
      socket = ws;

      await new Promise<void>((resolve, reject) => {
        const onReady = (): void => resolve();
        ws.on('message', (raw: Buffer) => handleMessage(raw, onReady));
        ws.once('open', () => {
          ws.send(
            JSON.stringify(
              makeEnvelope({
                type: 'hello',
                userId: options.userId,
                deviceId: options.deviceId,
                payload: { role: 'daemon' },
              }),
            ),
          );
        });
        ws.once('error', reject);
      });
    },

    async stop(): Promise<void> {
      socket?.close();
      socket = null;
    },
  };
}
