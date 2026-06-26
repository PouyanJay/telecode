import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino, type Logger } from 'pino';
import type { WebSocket } from 'ws';

import {
  helloPayloadSchema,
  makeEnvelope,
  parseEnvelope,
  sessionEndedPayloadSchema,
  type Envelope,
} from '@telecode/protocol';

import { type AuthService } from './auth/auth-service';
import { registerAuthRoutes } from './auth/auth-routes';
import { type OAuthTokenStore } from './auth/oauth-token-store';
import { createGithubClient, type GithubClient } from './github/github-client';
import { registerRepoListRoute } from './github/repo-routes';
import { registerPushRoutes } from './push/push-routes';
import { type PushSender } from './push/push-sender';
import { type PushSubscriptionStore } from './push/push-subscription-store';
import { createDeviceAuthService, hashDeviceToken, registerDeviceAuthRoutes } from './device-auth';
import { registerRateLimit, type RateLimitConfig } from './rate-limit';
import { type DeviceRegistry } from './registry/device-registry';
import { registerDeviceListRoute } from './registry/device-routes';
import { type SessionRegistry } from './registry/session-registry';
import { registerSessionListRoute } from './registry/session-routes';

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
   * Stores the user's OAuth access token encrypted at rest (requires `auth`). When provided, an access
   * token sent on `/auth/session` is persisted, and `/me/repos` is exposed (lists the user's GitHub
   * repos). Optional so deployments without a token-encryption key simply omit repo listing.
   */
  readonly oauthTokenStore?: OAuthTokenStore;
  /**
   * Device registry (Postgres-backed). When provided (with `auth` for the service secret), the relay
   * exposes the device-authorization endpoints — `/device/approve` persists the device under the
   * server-derived user — and requires every `daemon` peer to present a valid device token on `hello`
   * whose device matches the envelope's `(user_id, device_id)`. Optional so the echo path needs no DB.
   */
  readonly deviceRegistry?: DeviceRegistry;
  /** GitHub API client for `/me/repos`. Defaults to the real HTTP client; tests inject a fake. */
  readonly githubClient?: GithubClient;
  /**
   * Web push (requires `auth`). When provided, the relay exposes the subscription endpoints and sends a
   * notification to the user's subscriptions when a session goes `awaiting_input`. The sender is a DI
   * seam (real `web-push` impl in production; a fake in tests).
   */
  readonly push?: { readonly store: PushSubscriptionStore; readonly sender: PushSender };
  /**
   * WebSocket keepalive (Phase 4 Task 4). The relay pings every connected peer each `intervalMs` and
   * terminates any that didn't pong since the last round — this is how a half-open connection (laptop
   * sleep, silent network death) is detected, since such a socket never fires `close` on its own.
   * Terminating a dead daemon runs the normal disconnect path (browsers are told it went offline).
   * Defaults to 30s; `intervalMs <= 0` disables it. Tests inject a short interval.
   */
  readonly heartbeat?: { readonly intervalMs?: number };
  /**
   * Bounded per-session ciphertext cache (Phase 4 Task 8). The relay keeps the recent encrypted frames it
   * forwards (and the latest `session.key`) so a reopening browser can be replayed them immediately on
   * `session.subscribe` — instant recent history even while the daemon is mid-reconnect, decrypted with
   * the browser's persisted key (Task 7). Ciphertext only — the relay never reads the payload (invariant
   * #5). Defaults: 64 frames/session, 256 sessions. Tests inject small bounds.
   */
  readonly cache?: { readonly maxFramesPerSession?: number; readonly maxSessions?: number };
  /**
   * HTTP rate limiting (Phase 5). When provided, the relay registers a global per-IP window budget so a
   * hosted instance sheds abusive traffic before it reaches auth or the database. Absent (the default) the
   * limiter is OFF — the echo path and the test suite are unaffected; `main.ts` turns it on for production.
   */
  readonly rateLimit?: RateLimitConfig;
  /**
   * Trust `X-Forwarded-For` so `request.ip` is the real client when the relay runs behind a reverse proxy
   * / load balancer (the hosted topology). Required for per-IP rate limiting to be correct there — without
   * it every request appears to come from the proxy and the per-IP budget collapses into one global bucket.
   * Default false (direct connection / local dev). `main.ts` wires it from `TRUST_PROXY`.
   */
  readonly trustProxy?: boolean;
}

/** The daemon→browser frame types worth caching for an instant reopen (the session's recent history). */
const CACHEABLE_TYPES = new Set<string>([
  'session.started',
  'agent.message',
  'agent.tool_use',
  'agent.permission_request',
  'session.ended',
  'session.key',
]);

function channelKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

interface PeerState {
  role: 'daemon' | 'browser' | 'unknown';
  channel: string | null;
  userId: string | null;
  deviceId: string | null;
}

export async function buildRelay(options: RelayOptions = {}): Promise<FastifyInstance> {
  const log = options.logger ?? pino({ name: 'relay' });
  const app = Fastify({ logger: false, trustProxy: options.trustProxy ?? false });

  // One daemon per channel; any number of browsers watching a channel.
  const daemons = new Map<string, WebSocket>();
  const browsers = new Map<string, Set<WebSocket>>();
  // Heartbeat bookkeeping (Phase 4 Task 4): every connected socket and whether it has ponged since the
  // last ping round. A socket that misses a round is half-open (sleep / silent drop) and gets terminated.
  const sockets = new Set<WebSocket>();
  const liveness = new WeakMap<WebSocket, boolean>();
  // Bounded per-session ciphertext cache (Task 8): the latest `session.key` frame + a ring of recent
  // stream frames, all stored as the opaque forwarded strings (the relay never decrypts them).
  const cacheMaxFrames = options.cache?.maxFramesPerSession ?? 64;
  const cacheMaxSessions = options.cache?.maxSessions ?? 256;
  const ciphertextCache = new Map<string, { key?: string; stream: string[] }>();

  /** Record a forwarded daemon→browser frame for later replay (ciphertext string, never read). */
  function cacheFrame(sessionId: string, type: string, frame: string): void {
    let entry = ciphertextCache.get(sessionId);
    if (!entry) {
      // Bound the number of cached sessions: evict the oldest (Map preserves insertion order).
      if (ciphertextCache.size >= cacheMaxSessions) {
        const oldest = ciphertextCache.keys().next().value;
        if (oldest !== undefined) ciphertextCache.delete(oldest);
      }
      entry = { stream: [] };
      ciphertextCache.set(sessionId, entry);
    }
    if (type === 'session.key') {
      entry.key = frame; // keep only the latest key frame
    } else {
      entry.stream.push(frame);
      if (entry.stream.length > cacheMaxFrames) entry.stream.shift();
    }
  }

  /** Replay a session's cached frames to one browser (the `session.key` first, so the stream decrypts). */
  function replayCache(sessionId: string, browser: WebSocket): void {
    const entry = ciphertextCache.get(sessionId);
    if (!entry) return;
    try {
      if (entry.key !== undefined) browser.send(entry.key);
      for (const frame of entry.stream) browser.send(frame);
    } catch (err) {
      log.warn({ err, sessionId }, 'relay: failed to replay cached frames');
    }
  }
  const sessionRegistry = options.sessionRegistry;
  const authService = options.auth?.service;
  const deviceRegistry = options.deviceRegistry;
  const oauthTokenStore = options.oauthTokenStore;
  const push = options.push;

  /**
   * Notify the user's devices that a session needs input (Task 10). Fire-and-forget: it must never block
   * frame routing, and a failed/expired push (pruned on `gone`) must not surface as a relay error. The
   * payload is routing metadata only (id + deep-link) — never agent content (the relay can't read it).
   */
  function pushAwaitingInput(userId: string, sessionId: string): void {
    if (!push) return;
    void (async (): Promise<void> => {
      const subscriptions = await push.store.listByUser(userId).catch((err: unknown) => {
        log.warn({ err, sessionId }, 'relay: could not list push subscriptions');
        return [];
      });
      // allSettled, not all: one device's failed/expired push must not drop the others.
      const results = await Promise.allSettled(
        subscriptions.map(async (subscription) => {
          const { gone } = await push.sender.send(subscription, {
            title: 'A session needs your input',
            body: 'Tap to review the pending action.',
            data: { sessionId, url: `/sessions/${sessionId}` },
          });
          if (gone) await push.store.deleteByEndpoint({ userId, endpoint: subscription.endpoint });
        }),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          log.warn({ err: result.reason, sessionId }, 'relay: a push delivery failed');
        }
      }
    })();
  }

  /**
   * The terminal status of a `session.ended`: prefer the cleartext `status` envelope field (under E2E the
   * payload is ciphertext the relay can't read), fall back to the payload for cleartext-mode peers, and
   * default to `done`. Routing metadata only — the relay never reads the agent payload.
   */
  function resolveEndedStatus(envelope: Envelope): 'done' | 'error' {
    if (envelope.status === 'done' || envelope.status === 'error') return envelope.status;
    const fromPayload = sessionEndedPayloadSchema.safeParse(envelope.payload);
    return fromPayload.success ? fromPayload.data.status : 'done';
  }

  /**
   * A `device.presence` frame (relay → browsers): the daemon behind the channel is now online/offline.
   * Cleartext routing metadata the relay generates itself — no session payload, E2E-safe (the browser
   * pauses its live sessions when offline and resubscribes to resume them when online).
   */
  function presenceFrame(userId: string, deviceId: string, online: boolean): string {
    return JSON.stringify(
      makeEnvelope({ type: 'device.presence', userId, deviceId, payload: { online } }),
    );
  }

  function broadcastToBrowsers(channel: string, frame: string): void {
    const set = browsers.get(channel);
    if (!set) return;
    for (const browser of set) {
      try {
        browser.send(frame);
      } catch (err) {
        // The browser closed between its 'close' event and now — drop it rather than swallow the error.
        log.warn({ err, channel }, 'relay: dropping a browser that failed to receive');
        set.delete(browser);
      }
    }
  }

  async function routeFromBrowser(
    envelope: Envelope,
    channel: string,
    text: string,
    replyTo: WebSocket,
  ): Promise<void> {
    const daemon = daemons.get(channel);
    // Reopen = reconnect: replay this session's cached ciphertext to the subscribing browser immediately,
    // so recent history shows even while the daemon is offline/reconnecting (Task 8). The daemon's
    // authoritative `session.history` backfill follows when it forwards the subscribe below.
    if (envelope.type === 'session.subscribe' && envelope.session_id) {
      replayCache(envelope.session_id, replyTo);
    }
    if (envelope.type === 'session.launch' && sessionRegistry) {
      // The relay owns the session registry: mint the row (and its id) from envelope metadata, never
      // from the payload (which is opaque here and ciphertext in Phase 3).
      const sessionId = await sessionRegistry.createSession({
        userId: envelope.user_id,
        deviceId: envelope.device_id,
      });
      log.info({ channel, sessionId }, 'relay: session launching');
      if (!daemon) {
        // The device is offline: fail the row (so it never sticks at `starting`) and tell the
        // watching browsers, instead of leaving the launch silently orphaned.
        log.warn({ channel, sessionId }, 'relay: no daemon registered — failing launch (offline)');
        await sessionRegistry.markEnded({
          userId: envelope.user_id,
          sessionId,
          status: 'error',
        });
        broadcastToBrowsers(
          channel,
          JSON.stringify(
            makeEnvelope({
              type: 'session.ended',
              userId: envelope.user_id,
              deviceId: envelope.device_id,
              sessionId,
              // Relay-generated control message: cleartext (the relay holds no session key), so the
              // browser reads its outcome from the `status` field, not by decrypting the payload.
              status: 'error',
              payload: { status: 'error', error: 'device offline' },
            }),
          ),
        );
        return;
      }
      // Payload passes through opaque — the relay never reads it (E2E ciphertext in Phase 3). The
      // browser's `sender_public_key` must be carried through so the daemon can open the sealed launch
      // and wrap the session content key back to it (the relay rewrites the envelope only to inject the
      // minted session id, never to read or alter the E2E fields).
      daemon.send(
        JSON.stringify(
          makeEnvelope({
            type: 'session.launch',
            userId: envelope.user_id,
            deviceId: envelope.device_id,
            sessionId,
            payload: envelope.payload,
            nonce: envelope.nonce,
            ...(envelope.sender_public_key !== undefined
              ? { senderPublicKey: envelope.sender_public_key }
              : {}),
          }),
        ),
      );
      return;
    }
    // A human action resumes the session — a permission verdict, or a `user.message` follow-up that
    // starts a new turn. Flip the row back to `running` before forwarding (so the persisted status never
    // lags the daemon). Type-only — the relay stays payload-blind, correct under E2E ciphertext (Phase 3).
    if (
      (envelope.type === 'permission.decision' || envelope.type === 'user.message') &&
      sessionRegistry &&
      envelope.session_id
    ) {
      await sessionRegistry.markRunning({
        userId: envelope.user_id,
        sessionId: envelope.session_id,
      });
      log.info({ channel, sessionId: envelope.session_id }, 'relay: session resumed');
    }
    if (daemon) {
      daemon.send(text);
    } else {
      log.warn({ channel }, 'relay: no daemon registered for channel');
    }
  }

  async function routeFromDaemon(envelope: Envelope, channel: string, text: string): Promise<void> {
    if (sessionRegistry && envelope.session_id) {
      if (envelope.type === 'session.started') {
        await sessionRegistry.markRunning({
          userId: envelope.user_id,
          sessionId: envelope.session_id,
        });
        log.info({ channel, sessionId: envelope.session_id }, 'relay: session running');
      } else if (envelope.type === 'session.ended') {
        const status = resolveEndedStatus(envelope);
        await sessionRegistry.markEnded({
          userId: envelope.user_id,
          sessionId: envelope.session_id,
          status,
        });
        log.info({ channel, sessionId: envelope.session_id, status }, 'relay: session ended');
      } else if (envelope.type === 'agent.permission_request') {
        // The run is blocked on a human decision: persist `awaiting_input` BEFORE broadcasting the
        // request, so any browser that reacts to it already observes the paused status.
        await sessionRegistry.markAwaitingInput({
          userId: envelope.user_id,
          sessionId: envelope.session_id,
        });
        log.info({ channel, sessionId: envelope.session_id }, 'relay: session awaiting input');
        // Ping the user (web push) that a session needs them — fire-and-forget, routing metadata only.
        pushAwaitingInput(envelope.user_id, envelope.session_id);
      }
    }
    // Cache the recent ciphertext for an instant reopen (Task 8) — the forwarded string, never decrypted.
    if (envelope.session_id && CACHEABLE_TYPES.has(envelope.type)) {
      cacheFrame(envelope.session_id, envelope.type, text);
    }
    broadcastToBrowsers(channel, text);
  }

  await app.register(websocket);

  // HTTP rate limiting (Phase 5): registered before any route so the global per-IP budget covers them all.
  // Off unless configured, so the echo path and existing tests are untouched (see RelayOptions.rateLimit).
  if (options.rateLimit) {
    await registerRateLimit(app, options.rateLimit);
  }

  // Keepalive sweep (Phase 4 Task 4): ping every socket; terminate any that didn't pong since the last
  // round. Terminating a dead peer fires its `close` handler — so a dead daemon's browsers are told it
  // went offline, exactly as a clean disconnect would. `unref` so the timer never holds the process open.
  const heartbeatMs = options.heartbeat?.intervalMs ?? 30_000;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const ws of sockets) {
            if (liveness.get(ws) === false) {
              ws.terminate();
              continue;
            }
            liveness.set(ws, false);
            try {
              ws.ping();
            } catch {
              ws.terminate(); // a failed ping means the socket is already gone
            }
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref();
  app.addHook('onClose', async () => {
    if (heartbeat) clearInterval(heartbeat);
  });

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
    registerAuthRoutes(app, options.auth.service, {
      serviceSecret: options.auth.serviceSecret,
      ...(oauthTokenStore ? { tokenStore: oauthTokenStore } : {}),
    });
    // The web lists the user's devices to pick the channel its browser should watch.
    if (deviceRegistry) {
      registerDeviceListRoute(app, options.auth.service, deviceRegistry);
    }
    // The dashboard + reconnect list the user's sessions (status, device, title).
    if (sessionRegistry) {
      registerSessionListRoute(app, options.auth.service, sessionRegistry);
    }
    // The launch picker lists the user's GitHub repos (only when a token store is configured).
    if (oauthTokenStore) {
      registerRepoListRoute(
        app,
        options.auth.service,
        oauthTokenStore,
        options.githubClient ?? createGithubClient(),
      );
    }
    // Web push: register/remove subscriptions (the relay sends on awaiting_input).
    if (push) {
      registerPushRoutes(app, options.auth.service, push.store);
    }
  }

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const peer: PeerState = { role: 'unknown', channel: null, userId: null, deviceId: null };

    // Heartbeat liveness: track this socket and mark it alive on every pong (the ws client auto-replies
    // to the relay's ping). A round with no pong means a dead/half-open peer (Phase 4 Task 4).
    sockets.add(socket);
    liveness.set(socket, true);
    socket.on('pong', () => liveness.set(socket, true));
    socket.on('close', () => sockets.delete(socket));

    // Frame handling is async (session.* control messages await DB writes), so we chain frames into a
    // per-connection queue: each frame is fully handled before the next, preserving stream order (a
    // later agent.message must never overtake the session.started that awaited a DB write). Failures
    // are contained per-frame — never an unhandled rejection that would crash the relay.
    let processing: Promise<void> = Promise.resolve();
    socket.on('message', (raw: Buffer) => {
      processing = processing
        .then(() => handleFrame(raw))
        .catch((err: unknown) => {
          log.error({ err, channel: peer.channel }, 'relay: frame handling failed');
        });
    });

    /**
     * The `hello` handshake: authenticate the peer (browser channel token / daemon device token),
     * register it on its channel, and ack — or close 4001 on an auth failure. This is the connection
     * authn/authz boundary.
     */
    async function handleHello(envelope: Envelope, channel: string): Promise<void> {
      const hello = helloPayloadSchema.safeParse(envelope.payload);
      if (!hello.success) {
        log.warn({ channel }, 'relay: dropped hello with invalid payload');
        return;
      }
      const { role, token } = hello.data;

      // A browser must prove identity with a channel token whose subject is the envelope user — the
      // boundary that stops a browser from acting as another user.
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
      peer.userId = envelope.user_id;
      peer.deviceId = envelope.device_id;
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
      // Presence (Phase 4 Task 3): a (re)registering daemon tells watching browsers to resume; a browser
      // that connected while its device is offline is told so, so its live session list reflects reality.
      if (role === 'daemon') {
        broadcastToBrowsers(channel, presenceFrame(envelope.user_id, envelope.device_id, true));
      } else if (!daemons.has(channel)) {
        socket.send(presenceFrame(envelope.user_id, envelope.device_id, false));
      }
    }

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
        await handleHello(envelope, channel);
      } else if (peer.role === 'browser') {
        await routeFromBrowser(envelope, channel, text, socket);
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
          // The device just went offline — tell watching browsers so they pause its live sessions until
          // the daemon reconnects (Phase 4 Task 3).
          if (peer.userId !== null && peer.deviceId !== null) {
            broadcastToBrowsers(peer.channel, presenceFrame(peer.userId, peer.deviceId, false));
          }
        }
      } else if (peer.role === 'browser') {
        browsers.get(peer.channel)?.delete(socket);
      }
      log.info({ channel: peer.channel, role: peer.role }, 'relay: peer disconnected');
    });
  });

  return app;
}
