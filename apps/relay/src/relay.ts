import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino, type Logger } from 'pino';
import type { WebSocket } from 'ws';

import {
  helloPayloadSchema,
  isSessionEndStatus,
  makeEnvelope,
  parseEnvelope,
  sessionAdoptedPayloadSchema,
  sessionMetaPayloadSchema,
  sessionChainedPayloadSchema,
  sessionEndedPayloadSchema,
  sessionReconcilePayloadSchema,
  sessionStatusPayloadSchema,
  WS_CLOSE_UNAUTHORIZED,
  type Envelope,
  type SessionEndedPayload,
  type SessionStatusPayload,
} from '@telecode/protocol';

import { type AuthService } from './auth/auth-service';
import { registerAuthRoutes } from './auth/auth-routes';
import { type OAuthTokenStore } from './auth/oauth-token-store';
import { createGithubClient, type GithubClient } from './github/github-client';
import { registerRepoRoutes } from './github/repo-routes';
import { registerPushRoutes } from './push/push-routes';
import { type PushSender } from './push/push-sender';
import { type PushSubscriptionStore } from './push/push-subscription-store';
import { createDeviceAuthService, hashDeviceToken, registerDeviceAuthRoutes } from './device-auth';
import { registerRateLimit, type RateLimitConfig } from './rate-limit';
import { createTelemetry, type Telemetry } from './telemetry';
import { MAX_SEALED_BLOB_CHARS, MAX_SEALED_BLOB_NONCE_CHARS } from './db/sealed-blob-bounds';
import { registerInfraRoutes } from './infra/infra-routes';
import { type InfraScaler } from './infra/infra-scaler';
import { type DeviceRegistry } from './registry/device-registry';
import { registerDeviceRoutes } from './registry/device-routes';
import { type SessionRegistry } from './registry/session-registry';
import { registerSessionRoutes, type SessionRenamedEvent } from './registry/session-routes';

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
   * terminates any that showed NO inbound activity (frame, ping, or pong) for `maxSilentRounds` consecutive
   * rounds — this is how a half-open connection (laptop sleep, silent network death) is detected, since such
   * a socket never fires `close` on its own. Terminating a dead daemon runs the normal disconnect path
   * (browsers are told it went offline). Resetting on ANY inbound (not just a pong) plus the grace window
   * stops an idle-but-healthy peer — whose WS pong the cloud ingress doesn't reliably round-trip when idle —
   * from being torn down on a single miss. Defaults: 30s interval, 2 rounds (~60s of true silence; floored
   * at 1); `intervalMs <= 0` disables it. Tests inject short values.
   */
  readonly heartbeat?: { readonly intervalMs?: number; readonly maxSilentRounds?: number };
  /**
   * Bounded per-session ciphertext cache (Phase 4 Task 8). The relay keeps the recent encrypted frames it
   * forwards (and the latest `session.key`) so a reopening browser can be replayed them immediately on
   * `session.subscribe` — instant recent history even while the daemon is mid-reconnect, decrypted with
   * the browser's persisted key (Task 7). Ciphertext only — the relay never reads the payload (invariant
   * #5). Defaults: 64 frames/session, 256 sessions. Tests inject small bounds.
   */
  readonly cache?: { readonly maxFramesPerSession?: number; readonly maxSessions?: number };
  /**
   * HTTP rate limiting. When provided, the relay registers a global per-IP window budget so a
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
  /**
   * Max request body size in bytes (abuse prevention). The relay's HTTP bodies are all tiny JSON,
   * so a small cap rejects oversized payloads with 413 before buffering them. Absent → Fastify's 1MB
   * default; `main.ts` tightens it (env `BODY_LIMIT`).
   */
  readonly bodyLimit?: number;
  /**
   * Max concurrent WebSocket connections per client IP (abuse prevention). Rate limiting bounds how
   * fast connections open; this bounds how many are held, so one client can't exhaust memory by holding
   * many sockets. Counts the real client IP (needs `trustProxy` behind a proxy). Absent → unlimited
   * (existing tests untouched); `main.ts` sets a default (env `MAX_WS_CONNECTIONS_PER_IP`).
   */
  readonly maxConnectionsPerIp?: number;
  /**
   * Opt-in telemetry sink. Defaults to a no-op — telecode records nothing unless an operator
   * explicitly opts in (`main.ts` wires it from `TELECODE_TELEMETRY`). Events are aggregate (a role, never
   * identifiers or session content).
   */
  readonly telemetry?: Telemetry;
  /**
   * Operator-only infrastructure controls (the scale-to-zero toggles). When provided (with `auth`), the
   * relay exposes `/me/infra-settings` — gated to the `operatorEmails` allowlist — which reads/writes each
   * app's cloud minReplicas via the `InfraScaler`. Absent (the default) → the endpoints 404 and the web UI
   * hides the panel. `main.ts` wires it from the Azure env + `TELECODE_OPERATOR_EMAILS`.
   */
  readonly infra?: { readonly scaler: InfraScaler; readonly operatorEmails: readonly string[] };
}

/**
 * WebSocket close code for a connection refused by the per-IP connection cap (application range 4000–4999).
 * Exported so tests assert against the same constant rather than a duplicated magic number.
 */
export const WS_CLOSE_CODE_CONNECTION_CAP = 4029;

/**
 * The daemon→browser frame types worth caching for an instant reopen (the session's recent history).
 * `agent.notice` is deliberately excluded — it is a transient "needs attention" cue the web clears on the
 * next frame, so replaying a stale one on reopen would be misleading.
 */
const CACHEABLE_TYPES = new Set<string>([
  'session.started',
  'agent.message',
  'agent.tool_use',
  'agent.permission_request',
  'agent.question',
  // A free-form handover offer (Journey 4) is a standing, actionable offer — cache it so a browser that
  // reopens before answering still sees the "continue here" card (unlike the transient `agent.notice`).
  'agent.handover',
  'session.ended',
  'session.key',
  // Sealed session metadata (ux Phase 6): latest-wins identity for the session — cached (like the key,
  // outside the stream ring) so a reopening browser can label the session immediately.
  'session.meta',
  // Sealed branch-diff summary (branch-actions Phase C): latest-wins like `session.meta` — only the
  // freshest summary means anything, and replaying stale ones would flash wrong counts on reopen.
  'session.changes',
]);

/**
 * The largest `session.changes` FRAME (whole envelope JSON, ciphertext included) the reopen cache
 * keeps. The plaintext worst case is bounded by the protocol (MAX_CHANGED_FILES × path cap ≈ 110 KiB);
 * doubled for seal/base64/envelope overhead. Oversized frames still FORWARD live (the relay never
 * drops daemon traffic on size alone here) — they just don't occupy the cache slot.
 */
const MAX_CACHED_CHANGES_FRAME_CHARS = 256 * 1024;

/**
 * Session-scoped browser actions that get an honest `relay.error` reply when the daemon is offline —
 * everything a user clicks expecting the device to act. `session.launch` is excluded (it has its own
 * synthetic `session.ended` failure path) and `echo` stays fire-and-forget (Phase 0 skeleton).
 */
const UNDELIVERABLE_REPLY_TYPES: ReadonlySet<string> = new Set([
  'permission.decision',
  'question.answer',
  'handover.answer',
  'user.message',
  'session.control',
  'session.subscribe',
  // The delete flow's worktree reap (Phase C T3): box-sealed payload, but the envelope names the
  // session as routing metadata, so a reap that reached an offline device un-spins honestly.
  'workspace.reap',
  // The between-turns branch switch (Phase C T4): session-scoped like session.control.
  'session.branch.switch',
  // The Open-PR push leg (Phase C T6): a push clicked into an offline device un-spins honestly.
  'session.push',
]);

/**
/**
 * The storable form of a `session.meta` payload, WITHOUT reading sealed content. Ciphertext mode
 * (non-empty nonce): the payload must be a bounded string — size is the only checkable property.
 * Cleartext mode (legacy pre-E2E daemons): the payload must actually parse as session metadata — the
 * same trust-boundary validation `session.adopted`/`session.chained` get. `null` = drop the frame.
 * Bounds are the shared {@link MAX_SEALED_BLOB_CHARS}/{@link MAX_SEALED_BLOB_NONCE_CHARS} (also the DB
 * CHECK in migration 0008), so a hostile daemon can't bloat rows the relay can't read.
 */
function storableSealedMeta(envelope: Envelope): string | null {
  if (envelope.nonce.length > MAX_SEALED_BLOB_NONCE_CHARS) return null;
  if (envelope.nonce !== '') {
    return typeof envelope.payload === 'string' && envelope.payload.length <= MAX_SEALED_BLOB_CHARS
      ? envelope.payload
      : null;
  }
  const parsed = sessionMetaPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) return null;
  const json = JSON.stringify(parsed.data);
  return json.length <= MAX_SEALED_BLOB_CHARS ? json : null;
}

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
  const app = Fastify({
    logger: false,
    trustProxy: options.trustProxy ?? false,
    ...(options.bodyLimit !== undefined ? { bodyLimit: options.bodyLimit } : {}),
  });

  // One daemon per channel; any number of browsers watching a channel.
  const daemons = new Map<string, WebSocket>();
  const browsers = new Map<string, Set<WebSocket>>();
  // Heartbeat bookkeeping (Phase 4 Task 4): every connected socket and whether it has ponged since the
  // last ping round. A socket that misses a round is half-open (sleep / silent drop) and gets terminated.
  const sockets = new Set<WebSocket>();
  // Per-socket heartbeat liveness: `sawInbound` = any inbound activity (frame / ping / pong) since the last
  // sweep; `silentRounds` = consecutive sweeps that saw none. A peer is terminated only after
  // `heartbeatMaxSilentRounds` of true silence — resetting on ANY inbound (not just a pong) keeps an
  // idle-but-healthy peer, whose WS pong the cloud ingress may not round-trip when idle, from being dropped.
  const sawInbound = new WeakMap<WebSocket, boolean>();
  const silentRounds = new WeakMap<WebSocket, number>();
  // Per-IP concurrent WebSocket count, for the connection cap (abuse prevention). Unbounded when
  // the cap is unset.
  const maxConnectionsPerIp = options.maxConnectionsPerIp;
  const connectionsByIp = new Map<string, number>();
  // Bounded per-session ciphertext cache (Task 8): the latest `session.key` frame + a ring of recent
  // stream frames, all stored as the opaque forwarded strings (the relay never decrypts them).
  const cacheMaxFrames = options.cache?.maxFramesPerSession ?? 64;
  const cacheMaxSessions = options.cache?.maxSessions ?? 256;
  // Each entry records the CHANNEL its frames came in on — a session runs on exactly one device, so a
  // browser may only replay a session cached on its own channel. Without this, a browser could pull
  // another tenant's cached ciphertext by guessing a session UUID (payload stays E2E-sealed, but even
  // its existence/size must not cross the channel boundary).
  const ciphertextCache = new Map<
    string,
    { channel: string; key?: string; meta?: string; changes?: string; stream: string[] }
  >();

  /** Record a forwarded daemon→browser frame for later replay (ciphertext string, never read). */
  function cacheFrame(sessionId: string, channel: string, type: string, frame: string): void {
    let entry = ciphertextCache.get(sessionId);
    if (!entry) {
      // Bound the number of cached sessions: evict the oldest (Map preserves insertion order).
      if (ciphertextCache.size >= cacheMaxSessions) {
        const oldest = ciphertextCache.keys().next().value;
        if (oldest !== undefined) ciphertextCache.delete(oldest);
      }
      entry = { channel, stream: [] };
      ciphertextCache.set(sessionId, entry);
    }
    if (type === 'session.key') {
      entry.key = frame; // keep only the latest key frame
    } else if (type === 'session.meta') {
      entry.meta = frame; // latest-wins identity metadata (ux Phase 6) — never fills the stream ring
    } else if (type === 'session.changes') {
      // Latest-wins branch-diff summary (Phase C) — same story as the meta, plus a size bound:
      // this slot lives outside the ring and is never persisted, so one hostile/buggy daemon
      // frame could otherwise pin an arbitrarily large blob in memory indefinitely.
      if (frame.length <= MAX_CACHED_CHANGES_FRAME_CHARS) entry.changes = frame;
    } else {
      entry.stream.push(frame);
      if (entry.stream.length > cacheMaxFrames) entry.stream.shift();
    }
  }

  /**
   * Replay a session's cached frames to one browser (the `session.key` first, so the stream decrypts).
   * Scoped to the requesting `channel`: a session cached on another channel is never replayed, so a
   * browser can't read a session it doesn't own out of the shared cache (authorization boundary).
   */
  function replayCache(sessionId: string, channel: string, browser: WebSocket): void {
    const entry = ciphertextCache.get(sessionId);
    if (!entry || entry.channel !== channel) return;
    try {
      if (entry.key !== undefined) browser.send(entry.key);
      if (entry.meta !== undefined) browser.send(entry.meta);
      if (entry.changes !== undefined) browser.send(entry.changes);
      for (const frame of entry.stream) browser.send(frame);
    } catch (err) {
      log.warn({ err, sessionId }, 'relay: failed to replay cached frames');
    }
  }
  const telemetry = options.telemetry ?? createTelemetry();
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
  function resolveEndedStatus(envelope: Envelope): SessionEndedPayload['status'] {
    if (isSessionEndStatus(envelope.status)) return envelope.status;
    const fromPayload = sessionEndedPayloadSchema.safeParse(envelope.payload);
    return fromPayload.success ? fromPayload.data.status : 'done';
  }

  /**
   * The reported status of a `session.status` (adopted-takeover T1): prefer the cleartext `status`
   * envelope field, fall back to the payload for cleartext-mode peers. Only the two non-terminal,
   * daemon-reportable states are valid here — endings ride `session.ended`, gates their own frames;
   * anything else means a malformed frame and the caller drops it whole.
   */
  function resolveReportedStatus(envelope: Envelope): SessionStatusPayload['status'] | undefined {
    if (envelope.status === 'running' || envelope.status === 'waiting_local') {
      return envelope.status;
    }
    if (envelope.status !== undefined) return undefined;
    const fromPayload = sessionStatusPayloadSchema.safeParse(envelope.payload);
    return fromPayload.success ? fromPayload.data.status : undefined;
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

  /**
   * A synthetic relay-generated `session.ended` (relay → browsers): a session was retired server-side
   * (stale-row reconcile, device revoke) with no daemon to announce it. Cleartext `status` — the relay
   * holds no session key, and browsers read the terminal state off the field.
   */
  function sessionEndedFrame(
    userId: string,
    deviceId: string,
    sessionId: string,
    status: SessionEndedPayload['status'] = 'done',
  ): string {
    return JSON.stringify(
      makeEnvelope({
        type: 'session.ended',
        userId,
        deviceId,
        sessionId,
        status,
        payload: { status },
      }),
    );
  }

  /**
   * A `session.title` (relay → browsers, ux Phase 6 T6): the user's rename override, broadcast after a
   * successful `PATCH /me/sessions/:id`. A SET forwards the opaque ciphertext + its nonce verbatim (the
   * relay never reads it — invariant #5); a RESET-to-derived (null blob) carries the cleartext
   * `{ reset: true }` marker with an empty nonce (it holds no secret).
   */
  function sessionTitleFrame(event: SessionRenamedEvent): string {
    const isSealed = event.sealedTitle !== null && event.sealedTitleNonce !== null;
    return JSON.stringify(
      makeEnvelope({
        type: 'session.title',
        userId: event.userId,
        deviceId: event.deviceId,
        sessionId: event.sessionId,
        payload: isSealed ? event.sealedTitle : { reset: true },
        ...(isSealed ? { nonce: event.sealedTitleNonce } : {}),
      }),
    );
  }

  /** A `relay.error` (relay → the sending browser): its frame could not reach the (offline) daemon. */
  function relayErrorFrame(params: {
    readonly userId: string;
    readonly deviceId: string;
    readonly sessionId: string;
    readonly regarding: string;
  }): string {
    return JSON.stringify(
      makeEnvelope({
        type: 'relay.error',
        userId: params.userId,
        deviceId: params.deviceId,
        sessionId: params.sessionId,
        payload: { code: 'device_offline', regarding: params.regarding },
      }),
    );
  }

  /**
   * Honest failure (approval-reliability T3): a session-scoped action that reached an offline device is
   * answered with `relay.error` to the SENDER, so its UI un-spins the exact action — an approval that
   * went nowhere shows as undelivered, never as acted-on.
   */
  function sendUndeliverableReply(envelope: Envelope, replyTo: WebSocket, channel: string): void {
    if (envelope.session_id === undefined || !UNDELIVERABLE_REPLY_TYPES.has(envelope.type)) return;
    try {
      replyTo.send(
        relayErrorFrame({
          userId: envelope.user_id,
          deviceId: envelope.device_id,
          sessionId: envelope.session_id,
          regarding: envelope.type,
        }),
      );
    } catch (err) {
      log.warn({ err, channel }, 'relay: could not send relay.error to the browser');
    }
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

  /**
   * A `viewer.presence` frame (relay → daemon): the mirror of {@link presenceFrame}. Whether ANY browser is
   * currently connected on the channel. Cleartext routing metadata the relay generates itself; it lets the
   * daemon hold an adopted session's tool for a remote approval only while an operator is actually watching,
   * and otherwise defer to Claude Code's own local prompt (never freezing an unwatched local session).
   */
  function viewerPresenceFrame(userId: string, deviceId: string, online: boolean): string {
    return JSON.stringify(
      makeEnvelope({ type: 'viewer.presence', userId, deviceId, payload: { online } }),
    );
  }

  /** Tell the channel's daemon (if one is connected) whether any browser is currently watching it. */
  function notifyDaemonViewerPresence(userId: string, deviceId: string, online: boolean): void {
    const daemon = daemons.get(channelKey(userId, deviceId));
    if (daemon) daemon.send(viewerPresenceFrame(userId, deviceId, online));
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
      replayCache(envelope.session_id, channel, replyTo);
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
    // Presence frames are relay-generated routing metadata (`viewer.presence` relay→daemon, `device.presence`
    // relay→browser) — never legitimately browser-originated. Drop them so an authenticated browser can't
    // forge a `viewer.presence` to flip the daemon's adopted-session gating: the relay is the sole authority
    // on whether anyone is watching. `relay.error` and `session.title` are likewise relay-generated only —
    // a rename must go through `PATCH /me/sessions/:id` (which persists + bounds it), never a raw frame.
    if (
      envelope.type === 'viewer.presence' ||
      envelope.type === 'device.presence' ||
      envelope.type === 'relay.error' ||
      envelope.type === 'session.title'
    ) {
      log.warn(
        { channel, type: envelope.type },
        'relay: dropped a relay-internal frame from a browser',
      );
      return;
    }
    if (!daemon) {
      // Honest failure (approval-reliability T3): a session-scoped action that reaches an offline device
      // must not vanish into a log line — the SENDER is told, so its UI un-spins the exact action (an
      // approval that went nowhere shows as undelivered, never as acted-on). Relay-generated cleartext
      // routing metadata: code + the failed type; no session payload. The registry row is deliberately
      // NOT flipped to `running` for an undelivered resume action.
      log.warn({ channel, type: envelope.type }, 'relay: no daemon registered for channel');
      sendUndeliverableReply(envelope, replyTo, channel);
      return;
    }
    // A human action resumes the session — a permission verdict, a `question.answer` (an adopted session's
    // multiple-choice pick), or a `user.message` follow-up that starts a new turn. Flip the row back to
    // `running` before forwarding (so the persisted status never lags the daemon) — only now that the
    // frame is actually deliverable. Type-only — the relay stays payload-blind under E2E (Phase 3).
    if (
      (envelope.type === 'permission.decision' ||
        envelope.type === 'question.answer' ||
        envelope.type === 'user.message') &&
      sessionRegistry &&
      envelope.session_id
    ) {
      await sessionRegistry.markRunning({
        userId: envelope.user_id,
        sessionId: envelope.session_id,
      });
      log.info({ channel, sessionId: envelope.session_id }, 'relay: session resumed');
    }
    daemon.send(text);
  }

  /**
   * Reconcile the registry against what the daemon actually holds (`session.reconcile`, sent on every
   * (re)connect). Retire — mark `needs_restart` — any non-terminal session for this device the daemon no longer has,
   * clearing the phantom `awaiting_input`/`running` rows a revoke/restart leaves behind (they otherwise
   * resurrect on every dashboard refresh), and tell watching browsers so a live dashboard clears without one.
   * `'starting'` is deliberately NOT retired: a session just launched + forwarded to the daemon but not yet
   * accepted would be wrongly killed on a fast reconnect — a genuinely orphaned `starting` is already failed
   * by the offline-daemon launch path. Session ids are cleartext routing metadata (never a payload) — E2E-safe.
   */
  async function reconcileSessions(
    envelope: Envelope,
    channel: string,
    registry: SessionRegistry,
  ): Promise<void> {
    const parsed = sessionReconcilePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      log.warn({ channel }, 'relay: dropped session.reconcile with invalid payload');
      return;
    }
    const held = new Set(parsed.data.heldSessionIds);
    const rows = await registry.listByUser(envelope.user_id);
    const stale = rows.filter(
      (row) =>
        row.deviceId === envelope.device_id &&
        !held.has(row.id) &&
        (row.status === 'running' ||
          row.status === 'awaiting_input' ||
          row.status === 'waiting_local'),
    );
    // Retire the stale rows concurrently — independent DB writes; one failure must not block the rest.
    const results = await Promise.allSettled(
      stale.map(async (row) => {
        // `needs_restart` (status split, ux Phase 6 T2): the daemon LOST this conversation — it wasn't
        // completed and it didn't fail; it can only continue as a new session. The honest state moves
        // the phantom out of "awaiting" and tells the user exactly what a follow-up would need.
        await registry.markEnded({
          userId: envelope.user_id,
          sessionId: row.id,
          status: 'needs_restart',
        });
        // Tell watching browsers so a live dashboard clears the phantom without a refresh.
        broadcastToBrowsers(
          channel,
          sessionEndedFrame(envelope.user_id, envelope.device_id, row.id, 'needs_restart'),
        );
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    const retired = stale.length - failed;
    if (retired > 0) log.info({ channel, retired }, 'relay: reconciled stale sessions');
    else log.debug({ channel }, 'relay: session reconciliation — nothing stale');
    if (failed > 0) {
      // A row that failed to retire stays stale and is retried on the next reconnect.
      log.warn({ channel, failed }, 'relay: some stale sessions could not be retired');
    }
  }

  async function routeFromDaemon(envelope: Envelope, channel: string, text: string): Promise<void> {
    // Symmetry with the browser-side guard: presence, relay.error, and session.title are RELAY-generated
    // routing metadata. A daemon is trusted for its channel's content, but must not be able to impersonate
    // the relay's own control frames — a forged `session.title` would otherwise fall through to a verbatim,
    // unbounded, unpersisted broadcast that clobbers the title on every open tab (the exact clobber the
    // sealed_meta/sealed_title split exists to prevent). A rename is REST-only (`PATCH /me/sessions/:id`).
    if (
      envelope.type === 'viewer.presence' ||
      envelope.type === 'device.presence' ||
      envelope.type === 'relay.error' ||
      envelope.type === 'session.title'
    ) {
      log.warn(
        { channel, type: envelope.type },
        'relay: dropped a relay-internal frame from a daemon',
      );
      return;
    }
    // Session reconciliation is a relay-internal control frame — act on it, never forward it to browsers.
    if (envelope.type === 'session.reconcile') {
      if (sessionRegistry) await reconcileSessions(envelope, channel, sessionRegistry);
      return;
    }
    // Adopted sessions: the daemon discovered a Claude Code session the user started themselves and
    // announces it (no id yet). The relay mints an `origin='external'` row — daemon-initiated registration,
    // the mirror of a browser `session.launch` — then ACKs the daemon with the minted id (so it can pair
    // its hook events) and broadcasts the adopted session to the browsers. Routing metadata only; the
    // relay never reads the agent payload.
    if (
      envelope.type === 'session.adopted' &&
      sessionRegistry &&
      envelope.session_id === undefined
    ) {
      const parsed = sessionAdoptedPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) {
        log.warn({ channel }, 'relay: dropped session.adopted with invalid payload');
        return;
      }
      const { clientRef, title, cwd } = parsed.data;
      const sessionId = await sessionRegistry.createSession({
        userId: envelope.user_id,
        deviceId: envelope.device_id,
        origin: 'external',
        ...(title !== undefined ? { title } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
      log.info({ channel, sessionId }, 'relay: session adopted (external)');
      // ACK the daemon with the minted id + its own clientRef so it can pair its hook events to this id.
      daemons.get(channel)?.send(
        JSON.stringify(
          makeEnvelope({
            type: 'session.adopted',
            userId: envelope.user_id,
            deviceId: envelope.device_id,
            sessionId,
            payload: { clientRef },
          }),
        ),
      );
      // Surface the new adopted session to the watching browsers (the dashboard renders it as on-device).
      broadcastToBrowsers(
        channel,
        JSON.stringify(
          makeEnvelope({
            type: 'session.adopted',
            userId: envelope.user_id,
            deviceId: envelope.device_id,
            sessionId,
            payload: {
              clientRef,
              ...(title !== undefined ? { title } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
            },
          }),
        ),
      );
      return;
    }
    // Any other `session.adopted` (e.g. one already carrying a session_id) is handled entirely above; drop
    // it rather than letting it fall through to the broadcast at the end of this function.
    if (envelope.type === 'session.adopted') {
      return;
    }
    // Free-form handover (Journey 4): the user took over an adopted session's free-form question, so the
    // daemon launches a telecode-OWNED continuation that resumes the conversation and announces it here (no
    // id yet). Mint a `launched` row linked to the adopted parent via `parentSessionId`, ACK the daemon with
    // the minted id (so it can drive the child's turns), and broadcast it to the browsers — the mirror of
    // `session.adopted`, but launched. Routing metadata only; the relay never reads the agent payload.
    if (
      envelope.type === 'session.chained' &&
      sessionRegistry &&
      envelope.session_id === undefined
    ) {
      const parsed = sessionChainedPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) {
        log.warn({ channel }, 'relay: dropped session.chained with invalid payload');
        return;
      }
      const { clientRef, parentSessionId, title, cwd } = parsed.data;
      const sessionId = await sessionRegistry.createSession({
        userId: envelope.user_id,
        deviceId: envelope.device_id,
        origin: 'launched',
        parentSessionId,
        ...(title !== undefined ? { title } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
      log.info(
        { channel, sessionId, parentSessionId },
        'relay: session chained (handover continuation)',
      );
      daemons.get(channel)?.send(
        JSON.stringify(
          makeEnvelope({
            type: 'session.chained',
            userId: envelope.user_id,
            deviceId: envelope.device_id,
            sessionId,
            payload: { clientRef, parentSessionId },
          }),
        ),
      );
      broadcastToBrowsers(
        channel,
        JSON.stringify(
          makeEnvelope({
            type: 'session.chained',
            userId: envelope.user_id,
            deviceId: envelope.device_id,
            sessionId,
            payload: {
              clientRef,
              parentSessionId,
              ...(title !== undefined ? { title } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
            },
          }),
        ),
      );
      return;
    }
    // A `session.chained` already carrying an id is handled above; drop stragglers rather than broadcasting.
    if (envelope.type === 'session.chained') {
      return;
    }
    // Sealed session metadata (ux Phase 6): persist the OPAQUE blob latest-wins so a cold page load can
    // hand it back via GET /me/sessions, then cache + broadcast. The relay never reads sealed content
    // (invariant #5), but it DOES enforce bounds — and, for a legacy cleartext-mode daemon, the same
    // schema validation session.adopted/chained get — so a buggy or hostile daemon can't bloat the row.
    // An invalid or oversized frame is dropped entirely (not stored, not forwarded).
    if (envelope.type === 'session.meta') {
      if (envelope.session_id === undefined) return;
      const sealedMeta = storableSealedMeta(envelope);
      if (sealedMeta === null) {
        log.warn(
          { channel, sessionId: envelope.session_id },
          'relay: dropped session.meta with invalid payload',
        );
        return;
      }
      if (sessionRegistry) {
        await sessionRegistry.setSealedMeta({
          userId: envelope.user_id,
          sessionId: envelope.session_id,
          sealedMeta,
          sealedMetaNonce: envelope.nonce,
        });
        log.info({ channel, sessionId: envelope.session_id }, 'relay: session meta stored');
      }
      cacheFrame(envelope.session_id, channel, envelope.type, text);
      broadcastToBrowsers(channel, text);
      return;
    }
    // `session.ended` is terminal: get DONE to the watching browser IMMEDIATELY, then persist. The browser
    // is the live view and the daemon is the source of truth, so making the operator wait on a DB
    // round-trip to see the run finish — slow on a cold/auto-pausing DB — is the wrong tradeoff here. (The
    // ordering for `agent.permission_request` is deliberately the opposite: persist `awaiting_input` first.)
    if (envelope.type === 'session.ended') {
      if (envelope.session_id && CACHEABLE_TYPES.has(envelope.type)) {
        cacheFrame(envelope.session_id, channel, envelope.type, text);
      }
      broadcastToBrowsers(channel, text);
      if (sessionRegistry && envelope.session_id) {
        const status = resolveEndedStatus(envelope);
        await sessionRegistry.markEnded({
          userId: envelope.user_id,
          sessionId: envelope.session_id,
          status,
        });
        log.info({ channel, sessionId: envelope.session_id, status }, 'relay: session ended');
      }
      return;
    }
    // A non-terminal status report (adopted-takeover T1): an adopted session's turn ended
    // (`waiting_local`) or a new local turn began (`running`). Persist BEFORE broadcasting — like the
    // gate frames — so a reacting browser already observes the flipped registry row. A frame carrying
    // any other status is malformed and dropped whole (not persisted, not forwarded).
    if (envelope.type === 'session.status') {
      const reported = resolveReportedStatus(envelope);
      if (reported === undefined) {
        log.warn(
          { channel, sessionId: envelope.session_id },
          'relay: dropped session.status with an unreportable status',
        );
        return;
      }
      if (sessionRegistry && envelope.session_id) {
        const target = { userId: envelope.user_id, sessionId: envelope.session_id };
        await (reported === 'running'
          ? sessionRegistry.markRunning(target)
          : sessionRegistry.markWaitingLocal(target));
        log.info(
          { channel, sessionId: envelope.session_id, status: reported },
          'relay: session status reported',
        );
      }
      broadcastToBrowsers(channel, text);
      return;
    }
    if (sessionRegistry && envelope.session_id) {
      if (envelope.type === 'session.started') {
        await sessionRegistry.markRunning({
          userId: envelope.user_id,
          sessionId: envelope.session_id,
        });
        log.info({ channel, sessionId: envelope.session_id }, 'relay: session running');
      } else if (
        envelope.type === 'agent.permission_request' ||
        envelope.type === 'agent.question' ||
        envelope.type === 'agent.handover'
      ) {
        // The session needs the human: a permission decision, an `AskUserQuestion`, or a free-form handover
        // offer (an adopted session ended its turn asking a free-form question, Journey 4). All pause the
        // session on `awaiting_input` — persist it BEFORE broadcasting, so any browser that reacts already
        // observes the paused status. Type-only, payload-blind under E2E. (`agent.handover` never blocks the
        // daemon's hook; it just marks the session as needing a look until the user takes it over or not.)
        await sessionRegistry.markAwaitingInput({
          userId: envelope.user_id,
          sessionId: envelope.session_id,
        });
        log.info({ channel, sessionId: envelope.session_id }, 'relay: session awaiting input');
        // Ping the user (web push) that a session needs them — fire-and-forget, routing metadata only.
        pushAwaitingInput(envelope.user_id, envelope.session_id);
      } else if (envelope.type === 'agent.notice') {
        // A non-blocking attention cue (an adopted session went idle). Ping the user, but DON'T change the
        // persisted status — a notice is not a gate. The frame still broadcasts to live browsers below.
        pushAwaitingInput(envelope.user_id, envelope.session_id);
      }
    }
    // Cache the recent ciphertext for an instant reopen (Task 8) — the forwarded string, never decrypted.
    if (envelope.session_id && CACHEABLE_TYPES.has(envelope.type)) {
      cacheFrame(envelope.session_id, channel, envelope.type, text);
    }
    broadcastToBrowsers(channel, text);
  }

  await app.register(websocket);

  // HTTP rate limiting: registered before any route so the global per-IP budget covers them all.
  // Off unless configured, so the echo path and existing tests are untouched (see RelayOptions.rateLimit).
  if (options.rateLimit) {
    await registerRateLimit(app, options.rateLimit);
  }

  // Keepalive sweep (Phase 4 Task 4): each round, terminate any socket that saw NO inbound for
  // `heartbeatMaxSilentRounds` consecutive rounds, else re-probe with a ping. Terminating a dead peer fires
  // its `close` handler — so a dead daemon's browsers are told it went offline, exactly as a clean
  // disconnect would. `unref` so the timer never holds the process open.
  const heartbeatMs = options.heartbeat?.intervalMs ?? 30_000;
  // Floor at 1 round (and coerce a NaN from a bad config to the default): 0 would drop every peer each round.
  const configuredMaxSilentRounds = options.heartbeat?.maxSilentRounds ?? 2;
  const heartbeatMaxSilentRounds = Number.isFinite(configuredMaxSilentRounds)
    ? Math.max(1, configuredMaxSilentRounds)
    : 2;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const ws of sockets) {
            const rounds = sawInbound.get(ws) === true ? 0 : (silentRounds.get(ws) ?? 0) + 1;
            sawInbound.set(ws, false);
            silentRounds.set(ws, rounds);
            if (rounds >= heartbeatMaxSilentRounds) {
              ws.terminate();
              continue;
            }
            try {
              ws.ping(); // solicit a pong so an idle-but-healthy peer still produces inbound next round
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
  // device registry + the shared service secret are configured (the echo path needs neither). Kept in
  // scope so the device routes can surface its pending-restore state ("awaiting re-authorization").
  const deviceAuth =
    deviceRegistry && options.auth
      ? createDeviceAuthService({
          verificationUri: options.verificationUri ?? 'http://127.0.0.1:5173/activate',
          registry: deviceRegistry,
          logger: log,
        })
      : null;
  if (deviceAuth && options.auth) {
    registerDeviceAuthRoutes(app, deviceAuth, options.auth.serviceSecret);
  }

  // OAuth-session + channel-token endpoints (web → relay, server-to-server).
  if (options.auth) {
    registerAuthRoutes(app, options.auth.service, {
      serviceSecret: options.auth.serviceSecret,
      ...(oauthTokenStore ? { tokenStore: oauthTokenStore } : {}),
    });
    // The web lists the user's devices (to pick the channel its browser watches) and revokes them
    // (session-token authed; RLS-scoped to the owner). The revoke cascade reports the session ids it
    // ended so watching browsers hear about them immediately — same synthetic frame as reconcile.
    if (deviceRegistry) {
      registerDeviceRoutes(app, options.auth.service, deviceRegistry, {
        ...(sessionRegistry ? { sessionRegistry } : {}),
        ...(deviceAuth
          ? { pendingRestoreDeviceIds: () => deviceAuth.pendingRestoreDeviceIds() }
          : {}),
        // Presence snapshot for cold loads (ux Phase 5): the in-memory daemon channel map is the truth.
        isDeviceOnline: (userId, deviceId) => daemons.has(channelKey(userId, deviceId)),
        onSessionsEnded: ({ userId, deviceId, sessionIds }) => {
          const channel = channelKey(userId, deviceId);
          for (const sessionId of sessionIds) {
            broadcastToBrowsers(channel, sessionEndedFrame(userId, deviceId, sessionId));
          }
        },
      });
    }
    // Operator-only infra controls (scale-to-zero toggles). Registered only when configured (Azure env);
    // every request is gated to the operator allowlist inside the routes.
    if (options.infra) {
      registerInfraRoutes(
        app,
        options.auth.service,
        options.infra.scaler,
        options.infra.operatorEmails,
      );
    }
    // The dashboard + reconnect list the user's sessions; a rename (PATCH) broadcasts a `session.title`
    // frame on the session's device channel so every open tab updates the title without a refresh.
    if (sessionRegistry) {
      registerSessionRoutes(app, options.auth.service, sessionRegistry, {
        onSessionRenamed: (event) => {
          broadcastToBrowsers(channelKey(event.userId, event.deviceId), sessionTitleFrame(event));
        },
        // A deleted session's cached ciphertext must never replay to a later subscriber (T7).
        onSessionDeleted: ({ sessionId }) => {
          ciphertextCache.delete(sessionId);
        },
      });
    }
    // The launch picker lists the user's GitHub repos (only when a token store is configured).
    if (oauthTokenStore) {
      registerRepoRoutes(
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

  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    // Per-IP connection cap (abuse prevention): refuse a caller already at the cap before it can
    // register, so one client can't hold open enough sockets to exhaust memory. `request.ip` is the real
    // client when trustProxy is on. Decremented on close below.
    const ip = request.ip;
    if (maxConnectionsPerIp !== undefined) {
      const current = connectionsByIp.get(ip) ?? 0;
      if (current >= maxConnectionsPerIp) {
        log.warn({ ip }, 'relay: refusing WS connection — per-IP cap reached');
        socket.close(WS_CLOSE_CODE_CONNECTION_CAP, 'too many connections');
        return;
      }
      connectionsByIp.set(ip, current + 1);
      socket.on('close', () => {
        const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
        if (remaining <= 0) connectionsByIp.delete(ip);
        else connectionsByIp.set(ip, remaining);
      });
    }

    const peer: PeerState = { role: 'unknown', channel: null, userId: null, deviceId: null };

    // Heartbeat liveness: track this socket and mark it alive on ANY inbound activity — a frame, the ws
    // client's auto-pong to our ping, or the peer's own keepalive ping (the daemon pings us too). Not just
    // the pong, since the cloud ingress may not round-trip a WS pong on an idle-but-healthy connection.
    // Assume alive on connect (the hello arrives immediately); a sweep proves otherwise (Phase 4 Task 4).
    sockets.add(socket);
    sawInbound.set(socket, true);
    silentRounds.set(socket, 0);
    const markInbound = (): void => {
      sawInbound.set(socket, true);
    };
    socket.on('pong', markInbound);
    socket.on('ping', markInbound);
    socket.on('close', () => sockets.delete(socket));

    // Frame handling is async (session.* control messages await DB writes), so we chain frames into a
    // per-connection queue: each frame is fully handled before the next, preserving stream order (a
    // later agent.message must never overtake the session.started that awaited a DB write). Failures
    // are contained per-frame — never an unhandled rejection that would crash the relay.
    let processing: Promise<void> = Promise.resolve();
    socket.on('message', (raw: Buffer) => {
      markInbound(); // an inbound frame is proof of life — resets the heartbeat silence counter
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
      // Identity is established ONCE (session-identity T2a): a second hello on a registered socket is
      // never a legitimate client (both the web and daemon open a fresh socket per (re)connect and hello
      // once). Reject it rather than silently rebinding `peer`, which would strand the old channel's map
      // entry pointing at this socket. Closing forces the client's own reconnect path.
      if (peer.role !== 'unknown') {
        log.warn(
          { channel: peer.channel },
          'relay: rejected a second hello on a registered socket',
        );
        socket.close(WS_CLOSE_UNAUTHORIZED, 'hello already sent');
        return;
      }
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
          socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
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
          socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        // Presence honesty: stamp last_seen_at so the UI's "last seen" is real data. Fire-and-forget —
        // registration must never wait on (or fail with) this write: a slow/hung DB would otherwise
        // stall the handshake unbounded. Symmetric with the disconnect stamp in the close handler.
        deviceRegistry.touchLastSeen(device.id).catch((err: unknown) => {
          log.warn({ err, channel }, 'relay: could not stamp last_seen_at on hello');
        });
      }

      peer.role = role;
      peer.channel = channel;
      peer.userId = envelope.user_id;
      peer.deviceId = envelope.device_id;
      if (role === 'daemon') {
        daemons.set(channel, socket);
      } else {
        const set = browsers.get(channel) ?? new Set<WebSocket>();
        const firstBrowser = set.size === 0;
        set.add(socket);
        browsers.set(channel, set);
        // First browser on the channel → an operator is now watching; tell the daemon so it routes adopted
        // gates remotely (the mirror of device.presence). A no-op until the daemon connects — its own
        // registration below then reads the current browser count.
        if (firstBrowser) {
          notifyDaemonViewerPresence(envelope.user_id, envelope.device_id, true);
        }
      }
      log.info({ channel, role }, 'relay: peer registered');
      // Opt-in telemetry: aggregate connection count by role — no identifiers (default no-op).
      telemetry.record({ name: 'peer_connected', role });
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
      // Presence (Phase 4 Task 3): a (re)registering daemon tells watching browsers to resume. A
      // connecting browser always gets one presence snapshot — online or offline — so it renders the
      // device's real state instead of assuming (honesty pass T2; it used to get a frame only when the
      // daemon was absent, leaving a cold tab with no positive confirmation).
      if (role === 'daemon') {
        broadcastToBrowsers(channel, presenceFrame(envelope.user_id, envelope.device_id, true));
        // Tell the freshly-(re)connected daemon whether an operator is already watching, so its adopted-
        // session gate starts with the right posture instead of assuming nobody is present.
        notifyDaemonViewerPresence(
          envelope.user_id,
          envelope.device_id,
          (browsers.get(channel)?.size ?? 0) > 0,
        );
      } else {
        socket.send(presenceFrame(envelope.user_id, envelope.device_id, daemons.has(channel)));
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
        return;
      }
      // Identity binding (session-identity T2a): a peer's (user_id, device_id) is authenticated ONCE,
      // at hello — every later frame must carry the same pair. The envelope fields are an unauthenticated
      // claim; without this check an authed daemon could stamp another user's ids on a frame and write
      // into their registry or broadcast into their channel (RLS + a guessed session UUID were the only
      // barriers). The socket is the truth. Forged frames are dropped, never re-routed.
      if (envelope.user_id !== peer.userId || envelope.device_id !== peer.deviceId) {
        // A registered peer forging ANOTHER identity is the actionable signal — log it loudly with both
        // its real channel and the one it claimed. A frame before `hello` (unknown role) is routine
        // client noise (a racing/early send); keep it at debug so it can't drown the real signal or be
        // used as an unauthenticated log-spam vector.
        if (peer.role === 'unknown') {
          log.debug({ type: envelope.type }, 'relay: dropped a frame received before hello');
        } else {
          log.warn(
            { peerChannel: peer.channel, claimedChannel: channel, type: envelope.type },
            'relay: dropped a frame whose identity does not match the authenticated peer',
          );
        }
        return;
      }
      if (peer.role === 'browser') {
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
        // Close the presence window: the disconnect stamp makes "last seen" honest while the device is
        // offline. Fire-and-forget — a close handler must not block, and a failed stamp only means a
        // slightly staler timestamp until the next hello.
        if (peer.deviceId !== null && deviceRegistry) {
          deviceRegistry.touchLastSeen(peer.deviceId).catch((err: unknown) => {
            log.warn(
              { err, channel: peer.channel },
              'relay: could not stamp last_seen_at on close',
            );
          });
        }
      } else if (peer.role === 'browser') {
        const set = browsers.get(peer.channel);
        set?.delete(socket);
        // Last browser left the channel → no operator is watching; tell the daemon so its adopted-session
        // gate falls back to Claude Code's own local prompt instead of freezing on a remote approval no one
        // is there to give.
        if (set && set.size === 0 && peer.userId !== null && peer.deviceId !== null) {
          notifyDaemonViewerPresence(peer.userId, peer.deviceId, false);
        }
      }
      if (peer.role === 'daemon' || peer.role === 'browser') {
        telemetry.record({ name: 'peer_disconnected', role: peer.role });
      }
      log.info({ channel: peer.channel, role: peer.role }, 'relay: peer disconnected');
    });
  });

  return app;
}
