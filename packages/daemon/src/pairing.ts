import { deviceCodeResponseSchema, pollResultSchema } from '@telecode/protocol';
import { pino, type Logger } from 'pino';

/**
 * Device-pairing flow (RFC 8628 client side): request a code, show it to the user, then poll until
 * the relay reports the device approved and hands back a long-lived device token. Phase 0 self-host:
 * the token is stored by the caller (e.g. `~/.telecode/credentials`); real OAuth provider later.
 */
export interface PairDeviceOptions {
  readonly relayHttpUrl: string;
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  /** Invoked with the user code to display/enter. Awaited before polling begins. */
  readonly onPrompt?: (info: { userCode: string; verificationUri: string }) => void | Promise<void>;
  readonly logger?: Logger;
}

export interface DeviceCredentials {
  readonly deviceToken: string;
  readonly userId: string;
}

export async function pairDevice(options: PairDeviceOptions): Promise<DeviceCredentials> {
  const log = options.logger ?? pino({ name: 'daemon:pair' });

  const codeRes = await fetch(`${options.relayHttpUrl}/device/code`, { method: 'POST' });
  if (!codeRes.ok) {
    throw new Error(`device/code request failed: ${codeRes.status}`);
  }
  const code = deviceCodeResponseSchema.parse(await codeRes.json());

  const prompt = { userCode: code.user_code, verificationUri: code.verification_uri };
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
      log.info({ userId: result.user_id }, 'daemon: device paired');
      return { deviceToken: result.device_token, userId: result.user_id };
    }
    if (result.status === 'expired') {
      throw new Error('device code expired before approval');
    }
  }
  throw new Error('device pairing timed out');
}
