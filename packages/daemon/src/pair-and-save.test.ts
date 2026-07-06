import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceCredentials, PairDeviceOptions } from './pairing';
import { pairAndSaveCredentials } from './pair-and-save';

/**
 * Identity-preserving pairing (UX Phase 4): when credentials already exist on disk (the device was
 * revoked — its token is dead but its identity is not), a re-pair must (a) KEEP the X25519 keypair,
 * (b) present the prior token as restore evidence, and (c) leave the old credentials untouched until
 * the new pairing SUCCEEDS — a crash mid-pair must not orphan the machine's identity. A fresh machine
 * (no credentials) pairs exactly as before: new keypair, no evidence.
 */
const PRIOR = {
  deviceToken: 'dt_prior-token',
  userId: 'user-1',
  deviceId: 'device-1',
  publicKey: 'prior-public-key',
  privateKey: 'prior-private-key',
};

const APPROVED: DeviceCredentials = {
  deviceToken: 'dt_new-token',
  userId: 'user-1',
  deviceId: 'device-1',
};

describe('pairAndSaveCredentials', () => {
  let dir: string;
  let credentialsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-pair-'));
    credentialsPath = join(dir, 'credentials.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('re-pairs with the RETAINED keypair + prior token as restore evidence', async () => {
    await writeFile(credentialsPath, JSON.stringify(PRIOR), { mode: 0o600 });
    const pair = vi.fn(async (_options: PairDeviceOptions) => {
      // The old credentials must still be intact while the grant is in flight.
      expect(JSON.parse(await readFile(credentialsPath, 'utf8'))).toEqual(PRIOR);
      return APPROVED;
    });

    const creds = await pairAndSaveCredentials({
      relayHttpUrl: 'http://relay.test',
      credentialsPath,
      name: 'mbp',
      os: 'macOS 15.4',
      pair,
    });

    expect(pair).toHaveBeenCalledOnce();
    const sent = pair.mock.calls[0]![0];
    expect(sent.publicKey).toBe(PRIOR.publicKey); // same identity keypair, not a fresh one
    expect(sent.priorDeviceToken).toBe(PRIOR.deviceToken); // restore evidence presented
    // The saved credentials carry the NEW token and the RETAINED keypair.
    expect(creds).toEqual({
      ...APPROVED,
      publicKey: PRIOR.publicKey,
      privateKey: PRIOR.privateKey,
    });
    expect(JSON.parse(await readFile(credentialsPath, 'utf8'))).toEqual(creds);
  });

  it('pairs fresh (new keypair, no evidence) when no credentials exist', async () => {
    const pair = vi.fn(async (_options: PairDeviceOptions) => APPROVED);

    const creds = await pairAndSaveCredentials({
      relayHttpUrl: 'http://relay.test',
      credentialsPath,
      name: 'mbp',
      os: 'macOS 15.4',
      pair,
    });

    const sent = pair.mock.calls[0]![0];
    expect(sent.priorDeviceToken).toBeUndefined();
    expect(sent.publicKey).toBeDefined();
    expect(sent.publicKey).not.toBe(PRIOR.publicKey);
    expect(creds.publicKey).toBe(sent.publicKey);
    expect(creds.privateKey).toBeDefined();
  });

  it('leaves the old credentials on disk when pairing fails (retry keeps the restore evidence)', async () => {
    await writeFile(credentialsPath, JSON.stringify(PRIOR), { mode: 0o600 });
    const pair = vi.fn(async (): Promise<DeviceCredentials> => {
      throw new Error('device pairing timed out');
    });

    await expect(
      pairAndSaveCredentials({
        relayHttpUrl: 'http://relay.test',
        credentialsPath,
        name: 'mbp',
        os: 'macOS 15.4',
        pair,
      }),
    ).rejects.toThrow('device pairing timed out');

    // The identity survives the failure — the next attempt can still present it.
    expect(JSON.parse(await readFile(credentialsPath, 'utf8'))).toEqual(PRIOR);
  });

  it('treats a corrupt credentials file as absent (fresh pair, no evidence)', async () => {
    await writeFile(credentialsPath, 'not-json{', { mode: 0o600 });
    const pair = vi.fn(async (_options: PairDeviceOptions) => APPROVED);

    const creds = await pairAndSaveCredentials({
      relayHttpUrl: 'http://relay.test',
      credentialsPath,
      name: 'mbp',
      os: 'macOS 15.4',
      pair,
    });

    expect(pair.mock.calls[0]![0].priorDeviceToken).toBeUndefined();
    expect(creds.deviceToken).toBe(APPROVED.deviceToken);
  });

  it('forwards the onPrompt hook to the grant so the composition root controls surfacing', async () => {
    const onPrompt = (): void => undefined;
    const pair = vi.fn(async (_options: PairDeviceOptions) => APPROVED);
    await pairAndSaveCredentials({
      relayHttpUrl: 'http://relay.test',
      credentialsPath,
      name: 'mbp',
      os: 'macOS 15.4',
      onPrompt,
      pair,
    });
    expect(pair.mock.calls[0]![0].onPrompt).toBe(onPrompt);
  });
});
