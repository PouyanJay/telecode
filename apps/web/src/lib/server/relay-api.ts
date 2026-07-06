import {
  deviceApproveResponseSchema,
  SESSION_ORIGINS,
  SESSION_STATUSES,
  type SessionOrigin,
  type SessionStatusName,
} from '@telecode/protocol';
import { z } from 'zod';

import { env } from '$env/dynamic/private';

import type { ProviderIdentity } from './auth/provider';

/**
 * Server-to-server client for the relay's auth HTTP API. The relay owns persistence (AD-3); the web
 * tier holds only the first-party cookie and delegates session lifecycle here. `RELAY_SERVICE_SECRET`
 * authenticates session creation; the session token (from the cookie) authorizes the rest.
 */
const RELAY_HTTP_URL = env.RELAY_HTTP_URL ?? 'http://127.0.0.1:8080';
const SERVICE_SECRET = env.RELAY_SERVICE_SECRET ?? '';

export interface RelayUser {
  id: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface CreatedSession {
  token: string;
  userId: string;
  expiresAt: Date;
}

/** A paired device the signed-in user owns; the browser watches its `(user_id, id)` channel. */
export interface RelayDevice {
  id: string;
  name: string;
  /** Short OS descriptor (e.g. "macOS 15.4") reported by the daemon at pairing; null if unknown. */
  os: string | null;
  lastSeenAt: Date | null;
  /** The device daemon's X25519 public key (base64) for E2E key exchange; null if paired pre-E2E. */
  publicKey: string | null;
  /**
   * Presence snapshot (ux Phase 5): whether the device's daemon was on its relay channel when this
   * list was fetched — live `device.presence` frames take over once the WS lands. Null against a
   * pre-snapshot relay (deploy skew): unknown, not a claim.
   */
  online: boolean | null;
}

/** A revoked device the user still owns — shown in the Devices page's Revoked section. */
export interface RelayRevokedDevice {
  id: string;
  name: string;
  os: string | null;
  revokedAt: Date;
  /** Sessions this device ever held — the history that stays attached after revoke. */
  sessionCount: number;
  /** True while a verified re-authorization request is pending (the daemon is re-pairing). */
  pendingReauth: boolean;
}

/** A session in the user's registry (routing metadata only) — the dashboard's persisted list source. */
export interface RelaySession {
  id: string;
  deviceId: string;
  title: string | null;
  status: SessionStatusName;
  /** `launched` (started from telecode) or `external` (a session telecode adopted from the user's machine). */
  origin: SessionOrigin;
  /** The adopted session this one continues (free-form handover, Journey 4), or null when unchained. */
  parentSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
}

/** A provider's OAuth access token, forwarded to the relay for at-rest storage (never to the browser). */
export interface OAuthTokenInput {
  accessToken: string;
  scope?: string;
}

/**
 * Mint a login session for a verified identity (service-secret guarded). When the provider granted an
 * OAuth access token, it is forwarded here so the relay can persist it (encrypted) for later use.
 */
export async function createRelaySession(
  identity: ProviderIdentity,
  oauth?: OAuthTokenInput,
): Promise<CreatedSession> {
  const res = await fetch(`${RELAY_HTTP_URL}/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telecode-service-secret': SERVICE_SECRET },
    body: JSON.stringify({
      ...identity,
      ...(oauth
        ? {
            oauthAccessToken: oauth.accessToken,
            ...(oauth.scope ? { oauthScope: oauth.scope } : {}),
          }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`relay /auth/session failed: ${res.status}`);
  }
  const body = (await res.json()) as { token: string; user_id: string; expires_at: string };
  return { token: body.token, userId: body.user_id, expiresAt: new Date(body.expires_at) };
}

/** Resolve the current user for a session token, or null if invalid/expired. */
export async function getRelayUser(sessionToken: string): Promise<RelayUser | null> {
  const res = await fetch(`${RELAY_HTTP_URL}/auth/me`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as {
    id: string;
    display_name: string | null;
    email: string | null;
    avatar_url: string | null;
  };
  return {
    id: body.id,
    displayName: body.display_name,
    email: body.email,
    avatarUrl: body.avatar_url,
  };
}

/**
 * A relay registry read that keeps failure distinguishable from emptiness (error ≠ empty): `ok: false`
 * means the relay couldn't be reached / errored — the UI must show an error state, never "you have
 * nothing". `items` is always safe to render (empty on failure).
 */
export interface RelayListResult<T> {
  readonly ok: boolean;
  readonly items: T[];
}

/**
 * One place owns the error contract for registry list reads: an error status, an unreachable relay, or
 * a body that fails validation all yield `{ ok: false, items: [] }` — a failure the caller must
 * surface, never an empty account. `parse` returns null on shape mismatch (zod at the trust boundary).
 */
async function fetchRegistryList<Item>(
  path: string,
  sessionToken: string,
  parse: (body: unknown) => Item[] | null,
): Promise<RelayListResult<Item>> {
  try {
    const res = await fetch(`${RELAY_HTTP_URL}${path}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) {
      return { ok: false, items: [] };
    }
    const items = parse(await res.json());
    return items === null ? { ok: false, items: [] } : { ok: true, items };
  } catch {
    return { ok: false, items: [] };
  }
}

/** The relay's `GET /me/devices` body — validated, not cast (this is a trust boundary). */
const deviceListBodySchema = z.object({
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      os: z.string().nullable(),
      last_seen_at: z.string().nullable(),
      public_key: z.string().nullable(),
      // Optional: a pre-snapshot relay (deploy skew) omits it — presence then reads unknown.
      online: z.boolean().optional(),
    }),
  ),
});

/** List the user's active paired devices (session-token authed). */
export async function listDevices(sessionToken: string): Promise<RelayListResult<RelayDevice>> {
  return fetchRegistryList('/me/devices', sessionToken, (body) => {
    const parsed = deviceListBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return parsed.data.devices.map((device) => ({
      id: device.id,
      name: device.name,
      os: device.os,
      lastSeenAt: device.last_seen_at ? new Date(device.last_seen_at) : null,
      publicKey: device.public_key,
      online: device.online ?? null,
    }));
  });
}

/** The relay's `GET /me/devices/revoked` body — validated, not cast (this is a trust boundary). */
const revokedDeviceListBodySchema = z.object({
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      os: z.string().nullable(),
      revoked_at: z.string(),
      session_count: z.number(),
      pending_reauth: z.boolean(),
    }),
  ),
});

/** List the user's revoked devices (session-token authed) — the Devices page's Revoked section. */
export async function listRevokedDevices(
  sessionToken: string,
): Promise<RelayListResult<RelayRevokedDevice>> {
  return fetchRegistryList('/me/devices/revoked', sessionToken, (body) => {
    const parsed = revokedDeviceListBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return parsed.data.devices.map((device) => ({
      id: device.id,
      name: device.name,
      os: device.os,
      revokedAt: new Date(device.revoked_at),
      sessionCount: device.session_count,
      pendingReauth: device.pending_reauth,
    }));
  });
}

/** The outcome of a revoke attempt — `notFound` distinguishes "already gone" from a transient failure. */
export interface RevokeResult {
  readonly ok: boolean;
  readonly notFound: boolean;
}

/** Revoke one of the user's devices (session-token authed; the relay scopes it to the owner). */
export async function revokeDevice(sessionToken: string, deviceId: string): Promise<RevokeResult> {
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/me/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    return { ok: res.ok, notFound: res.status === 404 };
  } catch {
    // Relay unreachable — surface a retryable failure rather than throwing a 500 at the page action.
    return { ok: false, notFound: false };
  }
}

/** The relay's `GET /me/sessions` body — validated, not cast (this is a trust boundary). */
const sessionListBodySchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      device_id: z.string(),
      title: z.string().nullable(),
      // Enums rebuilt from the protocol's exported tuples (not its schema objects) so this file's zod
      // instance never composes another instance's types.
      status: z.enum(SESSION_STATUSES),
      origin: z.enum(SESSION_ORIGINS).optional(),
      parent_session_id: z.string().nullable().optional(),
      created_at: z.string(),
      updated_at: z.string(),
      ended_at: z.string().nullable(),
    }),
  ),
});

/** List the user's sessions, newest-first (session-token authed). */
export async function listSessions(sessionToken: string): Promise<RelayListResult<RelaySession>> {
  return fetchRegistryList('/me/sessions', sessionToken, (body) => {
    const parsed = sessionListBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return parsed.data.sessions.map((session) => ({
      id: session.id,
      deviceId: session.device_id,
      title: session.title,
      status: session.status,
      // Default to `launched` so a relay that predates the origin field degrades cleanly.
      origin: session.origin ?? 'launched',
      parentSessionId: session.parent_session_id ?? null,
      createdAt: new Date(session.created_at),
      updatedAt: new Date(session.updated_at),
      endedAt: session.ended_at ? new Date(session.ended_at) : null,
    }));
  });
}

/** A GitHub repo the user can launch a session against (for the launch picker). */
export interface RelayRepo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

/** The user's repos plus whether they've linked a GitHub token (`connected: false` → prompt to link). */
export interface RepoList {
  connected: boolean;
  repos: RelayRepo[];
}

/**
 * List the user's GitHub repos for the launch picker (session-token authed). The relay calls GitHub with
 * the user's stored token; this only ever sees repo metadata. Returns not-connected + empty on any error
 * (no token linked, GitHub unavailable) so the UI degrades cleanly.
 */
export async function listRepos(sessionToken: string): Promise<RepoList> {
  const res = await fetch(`${RELAY_HTTP_URL}/me/repos`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    return { connected: false, repos: [] };
  }
  const body = (await res.json()) as {
    connected: boolean;
    repos: {
      id: number;
      full_name: string;
      name: string;
      owner: string;
      private: boolean;
      default_branch: string;
      clone_url: string;
    }[];
  };
  return {
    connected: body.connected,
    repos: body.repos.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner,
      private: repo.private,
      defaultBranch: repo.default_branch,
      cloneUrl: repo.clone_url,
    })),
  };
}

/**
 * Register the browser's push subscription with the relay (session-token authed). The `subscription` is
 * the browser's `PushSubscription.toJSON()` (`{ endpoint, keys: { p256dh, auth } }`). Resolves true on
 * success.
 */
export async function savePushSubscription(
  sessionToken: string,
  subscription: unknown,
): Promise<boolean> {
  const res = await fetch(`${RELAY_HTTP_URL}/me/push-subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify(subscription),
  });
  return res.ok;
}

/** Remove a push subscription by endpoint (session-token authed). Best-effort. */
export async function deletePushSubscription(
  sessionToken: string,
  endpoint: string,
): Promise<void> {
  await fetch(`${RELAY_HTTP_URL}/me/push-subscriptions`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ endpoint }),
  });
}

/** Exchange a session token for a short-lived channel token, or null if the session is invalid. */
export async function mintChannelToken(sessionToken: string): Promise<string | null> {
  const res = await fetch(`${RELAY_HTTP_URL}/channel-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as { channel_token: string };
  return body.channel_token;
}

/**
 * The outcome of a device approval. `restored` is true when the approval re-authorized a revoked
 * device (identity + history preserved) rather than pairing a new one, and `deviceName` names it so
 * the activate page can say so. A pre-restore relay (deploy skew) returns just `{ ok: true }` → we
 * default to `restored: false`, matching its old behavior.
 */
export interface ApproveDeviceResult {
  readonly ok: boolean;
  readonly restored: boolean;
  readonly deviceName: string | null;
}

export async function approveDevice(
  userCode: string,
  userId: string,
): Promise<ApproveDeviceResult> {
  const failure: ApproveDeviceResult = { ok: false, restored: false, deviceName: null };
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telecode-service-secret': SERVICE_SECRET },
      body: JSON.stringify({ user_code: userCode, user_id: userId }),
    });
    if (!res.ok) return failure;
    // Tolerate an older relay that returns a bare { ok: true } with no restore fields.
    const parsed = deviceApproveResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { ok: true, restored: false, deviceName: null };
    return { ok: true, restored: parsed.data.restored, deviceName: parsed.data.device_name };
  } catch {
    // Relay unreachable — a retryable failure, not a thrown 500 at the activate action.
    return failure;
  }
}

/** Revoke a session (logout). Best-effort. */
export async function destroyRelaySession(sessionToken: string): Promise<void> {
  await fetch(`${RELAY_HTTP_URL}/auth/session`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

/**
 * Operator scale-to-zero state: whether each shared app is pinned always-on (vs. allowed to idle to 0). This
 * is the web tier's camelCase view of the relay's `InfraSettings` (the canonical type in
 * `apps/relay/src/infra/infra-scaler.ts`); the relay sends snake_case, mapped at this boundary.
 */
export interface InfraSettings {
  webAlwaysOn: boolean;
  relayAlwaysOn: boolean;
}

/** Map the relay's snake_case wire body to {@link InfraSettings}, defensively — returns null if malformed. */
function parseInfraSettings(body: unknown): InfraSettings | null {
  if (typeof body !== 'object' || body === null) return null;
  const { web_always_on: web, relay_always_on: relay } = body as Record<string, unknown>;
  if (typeof web !== 'boolean' || typeof relay !== 'boolean') return null;
  return { webAlwaysOn: web, relayAlwaysOn: relay };
}

/**
 * Read the operator infra (scale-to-zero) state (session-token authed). Returns null when the caller isn't an
 * operator or the controls aren't configured (403/404) — the UI then simply hides the panel. These settings
 * govern the SHARED deployment, so the relay gates them to the operator allowlist.
 */
export async function getInfraSettings(sessionToken: string): Promise<InfraSettings | null> {
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/me/infra-settings`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) {
      return null;
    }
    return parseInfraSettings(await res.json());
  } catch {
    return null;
  }
}

/**
 * Pin an app always-on or let it scale to zero (operator, session-token authed). Returns the freshly-read
 * state on success, or null on any failure (not operator, cloud unreachable) so the action can surface it.
 */
export async function setInfraSettings(
  sessionToken: string,
  target: 'web' | 'relay',
  alwaysOn: boolean,
): Promise<InfraSettings | null> {
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/me/infra-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ target, always_on: alwaysOn }),
    });
    if (!res.ok) {
      return null;
    }
    return parseInfraSettings(await res.json());
  } catch {
    return null;
  }
}
