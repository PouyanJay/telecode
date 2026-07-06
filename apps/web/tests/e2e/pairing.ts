/**
 * Shared e2e pairing harness: the relay's REAL device-grant flow (no seams), used by every spec
 * that needs a paired device. Signs in the dev identity server-side, requests a device code,
 * approves it as that user, and polls the token — exactly the daemon's production pairing path.
 */
const RELAY_HTTP = process.env.RELAY_HTTP_URL ?? 'http://127.0.0.1:8080';
const DEV_IDENTITY = {
  provider: 'dev',
  providerUserId: 'dev-user',
  displayName: 'Developer',
  email: 'dev@telecode.local',
};

export interface PairedDevice {
  userId: string;
  deviceId: string;
  deviceToken: string;
  /** The human pairing code — kept for specs that drive /activate themselves. */
  userCode: string;
  /** A relay session token for the dev user — lets a spec call owner-scoped REST (e.g. revoke). */
  sessionToken: string;
}

/** Run the device-grant flow; when `priorDeviceToken` is passed the relay may restore the same row. */
export async function pairDevice(
  serviceSecret: string,
  name: string,
  priorDeviceToken?: string,
): Promise<PairedDevice> {
  const svc = { 'content-type': 'application/json', 'x-telecode-service-secret': serviceSecret };

  const sessionRes = await fetch(`${RELAY_HTTP}/auth/session`, {
    method: 'POST',
    headers: svc,
    body: JSON.stringify(DEV_IDENTITY),
  });
  const { user_id: userId, token: sessionToken } = (await sessionRes.json()) as {
    user_id: string;
    token: string;
  };

  const codeRes = await fetch(`${RELAY_HTTP}/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      ...(priorDeviceToken ? { prior_device_token: priorDeviceToken } : {}),
    }),
  });
  const { device_code, user_code } = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
  };

  await fetch(`${RELAY_HTTP}/device/approve`, {
    method: 'POST',
    headers: svc,
    body: JSON.stringify({ user_code, user_id: userId }),
  });

  const tokenRes = await fetch(`${RELAY_HTTP}/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code }),
  });
  const poll = (await tokenRes.json()) as {
    status: string;
    device_token?: string;
    device_id?: string;
  };
  if (poll.status !== 'approved' || !poll.device_token || !poll.device_id) {
    throw new Error(`device pairing failed: ${JSON.stringify(poll)}`);
  }
  return {
    userId,
    deviceId: poll.device_id,
    deviceToken: poll.device_token,
    userCode: user_code,
    sessionToken,
  };
}

/** Revoke a paired device (owner-scoped) — spec cleanup so later files inherit no live leftovers. */
export async function revokeDevice(sessionToken: string, deviceId: string): Promise<void> {
  await fetch(`${RELAY_HTTP}/me/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

/** Mint a dev-user session token without pairing anything (for spec-level setup/cleanup calls). */
export async function devSessionToken(serviceSecret: string): Promise<string> {
  const res = await fetch(`${RELAY_HTTP}/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telecode-service-secret': serviceSecret },
    body: JSON.stringify(DEV_IDENTITY),
  });
  const { token } = (await res.json()) as { token: string };
  return token;
}

/**
 * Revoke EVERY active device of the dev user — a hermetic-baseline helper for specs whose
 * assertions depend on the fleet's size (earlier spec files and earlier local runs both accumulate
 * paired devices; the revoke cascade also retires their lingering sessions).
 */
export async function revokeAllDevices(sessionToken: string): Promise<void> {
  const res = await fetch(`${RELAY_HTTP}/me/devices`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  // Fail loudly: a spec relying on a clean fleet must not silently start from a dirty one.
  if (!res.ok) throw new Error(`revokeAllDevices: listing devices failed (${res.status})`);
  const body = (await res.json()) as { devices?: { id: string }[] };
  for (const device of body.devices ?? []) {
    await revokeDevice(sessionToken, device.id);
  }
}
