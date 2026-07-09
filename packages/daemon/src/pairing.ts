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

/** A poll HTTP status is retryable (transient) if it's a rate-limit (429) or a server error (5xx). */
function isRetryablePollStatus(status: number): boolean {
  return status === 429 || status >= 500;
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
    // A non-2xx is NOT a poll result — its body carries no `status`, so parsing it would crash the whole
    // pairing loop (the real re-pair failure: a burst of re-pair attempts trips the relay's rate limit and
    // a 429's `{ error, message }` body blows up the discriminated union). A transient status just means
    // "try again": skip to the next poll (the loop already waits `intervalMs`). Any other status is not
    // retryable — surface it clearly rather than letting a statusless body reach the parser.
    if (!tokenRes.ok) {
      if (!isRetryablePollStatus(tokenRes.status)) {
        throw new Error(`device/token poll failed: ${tokenRes.status}`);
      }
      log.warn(
        { status: tokenRes.status },
        'daemon: device/token poll throttled/unavailable — retrying',
      );
      continue;
    }
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
