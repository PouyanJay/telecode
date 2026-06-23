import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino, type Logger } from 'pino';
import type { WebSocket } from 'ws';

import { helloPayloadSchema, makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';

/**
 * The relay / control plane. Both the daemon and the browser dial *out* to it (loopback in
 * Phase 0; WSS in production), and it multiplexes messages by `(user_id, device_id)`. It never
 * needs to understand a payload — only `type` for the `hello` handshake — so it forwards the raw
 * frame untouched (this is what lets E2E ciphertext pass through unread in later phases).
 */
export interface RelayOptions {
  readonly logger?: Logger;
}

function channelKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

interface PeerState {
  role: 'daemon' | 'browser' | 'unknown';
  channel: string | null;
}

export async function buildRelay(options: RelayOptions = {}): Promise<FastifyInstance> {
  const log = options.logger ?? pino({ name: 'relay' });
  const app = Fastify({ logger: false });

  // One daemon per channel; any number of browsers watching a channel.
  const daemons = new Map<string, WebSocket>();
  const browsers = new Map<string, Set<WebSocket>>();

  await app.register(websocket);

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const peer: PeerState = { role: 'unknown', channel: null };

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString();
      let envelope: Envelope;
      try {
        envelope = parseEnvelope(JSON.parse(text));
      } catch (err) {
        log.warn({ err }, 'relay: dropped invalid envelope');
        return;
      }

      const channel = channelKey(envelope.user_id, envelope.device_id);

      if (envelope.type === 'hello') {
        const { role } = helloPayloadSchema.parse(envelope.payload);
        peer.role = role;
        peer.channel = channel;
        if (role === 'daemon') {
          daemons.set(channel, socket);
        } else {
          const set = browsers.get(channel) ?? new Set<WebSocket>();
          set.add(socket);
          browsers.set(channel, set);
        }
        log.info({ channel, role }, 'relay: peer registered');
        socket.send(
          JSON.stringify(
            makeEnvelope({
              type: 'hello.ack',
              userId: envelope.user_id,
              deviceId: envelope.device_id,
              payload: {},
            }),
          ),
        );
        return;
      }

      // Route by role — forward the raw frame; the relay never re-encodes the payload.
      if (peer.role === 'browser') {
        const daemon = daemons.get(channel);
        if (daemon) {
          daemon.send(text);
        } else {
          log.warn({ channel }, 'relay: no daemon registered for channel');
        }
      } else if (peer.role === 'daemon') {
        const set = browsers.get(channel);
        if (set) {
          for (const browser of set) {
            browser.send(text);
          }
        }
      }
    });

    socket.on('close', () => {
      if (peer.channel === null) {
        return;
      }
      if (peer.role === 'daemon') {
        if (daemons.get(peer.channel) === socket) {
          daemons.delete(peer.channel);
        }
      } else if (peer.role === 'browser') {
        browsers.get(peer.channel)?.delete(socket);
      }
      log.info({ channel: peer.channel, role: peer.role }, 'relay: peer disconnected');
    });
  });

  return app;
}
