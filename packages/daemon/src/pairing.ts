import { deviceCodeResponseSchema, pollResultSchema } from '@telecode/protocol';
import { pino, type Logger } from 'pino';

/**
 * Device-pairing flow (RFC 8628 client side): request a code, show it to the user, then poll until
 * the relay reports the device approved and hands back a long-lived device token. Phase 0 self-host:
 * the token is stored by the caller (e.g. `~/.telecode/credentials`); real OAuth provider later.
 */
export interface PairDeviceOptions {
  readonly relayHttpUrl: string;
  /** Human label for this device (defaults to the hostname). */
  readonly name?: string;
  /** Short OS descriptor (e.g. "macOS 15.4") shown next to the device in the UI. */
  readonly os?: string;
  /** This device's X25519 public key (base64), registered at pairing for E2E in Phase 3. */
  readonly publicKey?: string;
  /**
   * Restore evidence when re-pairing after a revoke: the prior (dead) device token. The relay
   * hash-matches it against the revoked device row so approval re-authorizes the SAME identity —
   * device id and session history preserved — instead of minting a new device.
   */
  readonly priorDeviceToken?: string;
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  /** Invoked with the user code to display/enter. Awaited before polling begins. */
  readonly onPrompt?: (info: {
    userCode: string;
    verificationUri: string;
    /** Relay-side TTL of the code, so the prompt can persist/show a real expiry. */
    expiresInSeconds: number;
  }) => void | Promise<void>;
  readonly logger?: Logger;
}

export interface DeviceCredentials {
  readonly deviceToken: string;
  readonly userId: string;
  readonly deviceId: string;
}

export async function pairDevice(options: PairDeviceOptions): Promise<DeviceCredentials> {
  // A logger-less caller gets a silent floor (never an unredacted root logger); main.ts passes the
  // real, redacting logger.
  const log = options.logger ?? pino({ level: 'silent' });

  const codeRes = await fetch(`${options.relayHttpUrl}/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.os !== undefined ? { os: options.os } : {}),
      ...(options.publicKey !== undefined ? { public_key: options.publicKey } : {}),
      ...(options.priorDeviceToken !== undefined
        ? { prior_device_token: options.priorDeviceToken }
        : {}),
    }),
  });
  if (!codeRes.ok) {
    throw new Error(`device/code request failed: ${codeRes.status}`);
  }
  const code = deviceCodeResponseSchema.parse(await codeRes.json());

  const prompt = {
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    expiresInSeconds: code.expires_in,
  };
  if (options.onPrompt) {
    await options.onPrompt(prompt);
  } else {
    log.info(prompt, `Go to ${code.verification_uri} and enter ${code.user_code}`);
  }

  const intervalMs = options.intervalMs ?? code.interval * 1000;
  const maxAttempts = options.maxAttempts ?? 300;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const tokenRes = await fetch(`${options.relayHttpUrl}/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: code.device_code }),
    });
    const result = pollResultSchema.parse(await tokenRes.json());
    if (result.status === 'approved') {
      log.info({ userId: result.user_id, deviceId: result.device_id }, 'daemon: device paired');
      return {
        deviceToken: result.device_token,
        userId: result.user_id,
        deviceId: result.device_id,
      };
    }
    if (result.status === 'expired') {
      throw new Error('device code expired before approval');
    }
  }
  throw new Error('device pairing timed out');
}
