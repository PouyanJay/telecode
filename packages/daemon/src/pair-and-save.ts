import { encodeKey, generateKeyPair } from '@telecode/protocol';
import type { Logger } from 'pino';

import { loadCredentials, saveCredentials, type StoredCredentials } from './credentials';
import { pairDevice, type DeviceCredentials, type PairDeviceOptions } from './pairing';

export interface PairAndSaveOptions {
  readonly relayHttpUrl: string;
  readonly credentialsPath: string;
  /** Human label for this device (the hostname, at the composition root). */
  readonly name: string;
  /** Short OS descriptor (e.g. "macOS 15.4"). */
  readonly os: string;
  readonly logger?: Logger;
  /** Injectable grant runner for tests; defaults to the real HTTP pairing client. */
  readonly pair?: (options: PairDeviceOptions) => Promise<DeviceCredentials>;
}

/**
 * Run the pairing grant and persist the result — identity-preserving across a revoke. A revoked
 * device still holds its identity: the keypair is RETAINED (the registry row keeps its public key;
 * anything sealed under it stays openable) and the dead token is presented as restore evidence so
 * the relay re-authorizes the SAME device row. The old credentials stay on disk until the new grant
 * SUCCEEDS — a crash or timeout mid-pair must not orphan the machine's identity. A fresh machine
 * (no/corrupt credentials) pairs exactly as before: new keypair, no evidence.
 */
export async function pairAndSaveCredentials(
  options: PairAndSaveOptions,
): Promise<StoredCredentials> {
  const pair = options.pair ?? pairDevice;
  const prior = await loadCredentials(options.credentialsPath);
  options.logger?.info(
    { restoring: prior !== null },
    prior ? 'daemon: re-pairing this device (identity retained)' : 'daemon: pairing this device',
  );
  const keyPair = prior
    ? { publicKey: prior.publicKey, privateKey: prior.privateKey }
    : await freshEncodedKeyPair();
  const paired = await pair({
    relayHttpUrl: options.relayHttpUrl,
    name: options.name,
    os: options.os,
    publicKey: keyPair.publicKey,
    ...(prior ? { priorDeviceToken: prior.deviceToken } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const creds: StoredCredentials = { ...paired, ...keyPair };
  await saveCredentials(creds, options.credentialsPath);
  options.logger?.info({ deviceId: creds.deviceId }, 'daemon: paired; credentials saved');
  return creds;
}

async function freshEncodedKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const generated = await generateKeyPair();
  return {
    publicKey: encodeKey(generated.publicKey),
    privateKey: encodeKey(generated.privateKey),
  };
}
