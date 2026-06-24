import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino, type Logger } from 'pino';
import type { WebSocket } from 'ws';

import { helloPayloadSchema, makeEnvelope, parseEnvelope, type Envelope } from '@telecode/protocol';

import { type AuthService } from './auth/auth-service';
import { registerAuthRoutes } from './auth/auth-routes';
import { createDeviceAuthService, hashDeviceToken, registerDeviceAuthRoutes } from './device-auth';
import { type DeviceRegistry } from './registry/device-registry';
import { type SessionRegistry } from './registry/session-registry';

/**
 * The relay / control plane. Both the daemon and the browser dial *out* to it (loopback in
 * Phase 0; WSS in production), and it multiplexes messages by `(user_id, device_id)`. It never
 * needs to understand a payload — only `type` for the `hello` handshake — so it forwards the raw
 * frame untouched (this is what lets E2E ciphertext pass through unread in later phases).
 */
export interface RelayOptions {
  readonly logger?: Logger;
  /** Where users go to enter the device code (shown by the daemon during pairing). */
  readonly verificationUri?: string;
  /**
   * Session registry (Postgres-backed). When provided, the relay persists a row on `session.launch`
   * and flips it to `running` on `session.started`. Optional so the Phase 0 echo path needs no DB.
   */
  readonly sessionRegistry?: SessionRegistry;
  /**
   * Auth service + the shared service secret. When provided, the relay exposes the `/auth/*` and
   * `/channel-token` endpoints and requires every `browser` peer to present a valid channel token on
   * `hello` whose `sub` matches the envelope's `user_id`. Optional so the Phase 0 echo path needs no auth.
   */
  readonly auth?: { readonly service: AuthService; readonly serviceSecret: string };
  /**
   * Device registry (Postgres-backed). When provided (with `auth` for the service secret), the relay
   * exposes the device-authorization endpoints — `/device/approve` persists the device under the
   * server-derived user — and requires every `daemon` peer to present a valid device token on `hello`
   * whose device matches the envelope's `(user_id, device_id)`. Optional so the echo path needs no DB.
   */
  readonly deviceRegistry?: DeviceRegistry;
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
  const sessionRegistry = options.sessionRegistry;
  const authService = options.auth?.service;
  const deviceRegistry = options.deviceRegistry;

  function broadcastToBrowsers(channel: string, frame: string): void {
    const set = browsers.get(channel);
    if (!set) return;
    for (const browser of set) {
      browser.send(frame);
    }
  }

  async function routeFromBrowser(
    envelope: Envelope,
    channel: string,
    text: string,
  ): Promise<void> {
    const daemon = daemons.get(channel);
    if (envelope.type === 'session.launch' && sessionRegistry) {
      // The relay owns the session registry: mint the row (and its id) from envelope metadata, never
      // from the payload (which is opaque here and ciphertext in Phase 3).
      const sessionId = await sessionRegistry.createSession({
        userId: envelope.user_id,
        deviceId: envelope.device_id,
      });
      log.info({ channel, sessionId }, 'relay: session launching');
      if (!daemon) {
        log.warn({ channel, sessionId }, 'relay: no daemon registered for channel');
        return;
      }
      // Stamp the generated session_id (envelope metadata) and forward; the payload passes through untouched.
      daemon.send(
        JSON.stringify(
          makeEnvelope({
            type: 'session.launch',
            userId: envelope.user_id,
            deviceId: envelope.device_id,
            sessionId,
            payload: envelope.payload,
            nonce: envelope.nonce,
          }),
        ),
      );
      return;
    }
    if (daemon) {
      daemon.send(text);
    } else {
      log.warn({ channel }, 'relay: no daemon registered for channel');
    }
  }

  async function routeFromDaemon(envelope: Envelope, channel: string, text: string): Promise<void> {
    if (envelope.type === 'session.started' && sessionRegistry && envelope.session_id) {
      await sessionRegistry.markRunning({
        userId: envelope.user_id,
        sessionId: envelope.session_id,
      });
      log.info({ channel, sessionId: envelope.session_id }, 'relay: session running');
    }
    broadcastToBrowsers(channel, text);
  }

  await app.register(websocket);

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Device Authorization Grant endpoints — persisted, server-derived approval. Registered only when a
  // device registry + the shared service secret are configured (the echo path needs neither).
  if (deviceRegistry && options.auth) {
    const deviceAuth = createDeviceAuthService({
      verificationUri: options.verificationUri ?? 'http://127.0.0.1:5173/activate',
      registry: deviceRegistry,
    });
    registerDeviceAuthRoutes(app, deviceAuth, options.auth.serviceSecret);
  }

  // OAuth-session + channel-token endpoints (web → relay, server-to-server).
  if (options.auth) {
    registerAuthRoutes(app, options.auth.service, { serviceSecret: options.auth.serviceSecret });
  }

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const peer: PeerState = { role: 'unknown', channel: null };

    socket.on('message', (raw: Buffer) => {
      // The handler awaits DB writes for session.* control messages, so it runs async; failures are
      // contained per-frame (logged, never an unhandled rejection that would crash the relay).
      void handleFrame(raw).catch((err: unknown) => {
        log.error({ err, channel: peer.channel }, 'relay: frame handling failed');
      });
    });

    async function handleFrame(raw: Buffer): Promise<void> {
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
        const hello = helloPayloadSchema.safeParse(envelope.payload);
        if (!hello.success) {
          log.warn({ channel }, 'relay: dropped hello with invalid payload');
          return;
        }
        const { role, token } = hello.data;

        // A browser must prove identity with a channel token whose subject is the envelope user.
        // This is the boundary that stops a browser from acting as another user.
        if (role === 'browser' && authService) {
          const tokenUserId = token ? await authService.verifyChannelToken(token) : null;
          if (tokenUserId === null || tokenUserId !== envelope.user_id) {
            log.warn({ channel }, 'relay: rejected browser hello (invalid channel token)');
            socket.close(4001, 'unauthorized');
            return;
          }
        }

        // A daemon must present its device token; the resolved device must match the envelope's
        // (user_id, device_id) and not be revoked. This is the laptop-side execution boundary.
        if (role === 'daemon' && deviceRegistry) {
          const device = token
            ? await deviceRegistry.findActiveByTokenHash(hashDeviceToken(token))
            : null;
          if (!device || device.userId !== envelope.user_id || device.id !== envelope.device_id) {
            log.warn({ channel }, 'relay: rejected daemon hello (invalid device token)');
            socket.close(4001, 'unauthorized');
            return;
          }
        }

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

      if (peer.role === 'browser') {
        await routeFromBrowser(envelope, channel, text);
      } else if (peer.role === 'daemon') {
        await routeFromDaemon(envelope, channel, text);
      }
    }

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
