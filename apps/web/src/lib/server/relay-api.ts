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

/** Mint a login session for a verified identity (service-secret guarded). */
export async function createRelaySession(identity: ProviderIdentity): Promise<CreatedSession> {
  const res = await fetch(`${RELAY_HTTP_URL}/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telecode-service-secret': SERVICE_SECRET },
    body: JSON.stringify(identity),
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

/** Revoke a session (logout). Best-effort. */
export async function destroyRelaySession(sessionToken: string): Promise<void> {
  await fetch(`${RELAY_HTTP_URL}/auth/session`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}
