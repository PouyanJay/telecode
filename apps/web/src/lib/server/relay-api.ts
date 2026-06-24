import { type SessionStatusName } from '@telecode/protocol';

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
  lastSeenAt: Date | null;
}

/** A session in the user's registry (routing metadata only) — the dashboard's persisted list source. */
export interface RelaySession {
  id: string;
  deviceId: string;
  title: string | null;
  status: SessionStatusName;
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

/** List the user's active paired devices (session-token authed). Empty on any error. */
export async function listDevices(sessionToken: string): Promise<RelayDevice[]> {
  const res = await fetch(`${RELAY_HTTP_URL}/me/devices`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    return [];
  }
  const body = (await res.json()) as {
    devices: { id: string; name: string; last_seen_at: string | null }[];
  };
  return body.devices.map((device) => ({
    id: device.id,
    name: device.name,
    lastSeenAt: device.last_seen_at ? new Date(device.last_seen_at) : null,
  }));
}

/** List the user's sessions, newest-first (session-token authed). Empty on any error. */
export async function listSessions(sessionToken: string): Promise<RelaySession[]> {
  const res = await fetch(`${RELAY_HTTP_URL}/me/sessions`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    return [];
  }
  const body = (await res.json()) as {
    sessions: {
      id: string;
      device_id: string;
      title: string | null;
      status: SessionStatusName;
      created_at: string;
      updated_at: string;
      ended_at: string | null;
    }[];
  };
  return body.sessions.map((session) => ({
    id: session.id,
    deviceId: session.device_id,
    title: session.title,
    status: session.status,
    createdAt: new Date(session.created_at),
    updatedAt: new Date(session.updated_at),
    endedAt: session.ended_at ? new Date(session.ended_at) : null,
  }));
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
 * Approve a pending device pairing for the authenticated user (server-derived). Service-secret guarded;
 * the relay binds the device to `userId` — the client never supplies it. Resolves true on success.
 */
export async function approveDevice(userCode: string, userId: string): Promise<boolean> {
  const res = await fetch(`${RELAY_HTTP_URL}/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telecode-service-secret': SERVICE_SECRET },
    body: JSON.stringify({ user_code: userCode, user_id: userId }),
  });
  return res.ok;
}

/** Revoke a session (logout). Best-effort. */
export async function destroyRelaySession(sessionToken: string): Promise<void> {
  await fetch(`${RELAY_HTTP_URL}/auth/session`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}
