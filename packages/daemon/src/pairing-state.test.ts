import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearPairingState,
  loadPairingState,
  resolvePairingStatePath,
  savePairingState,
} from './pairing-state';

/**
 * The on-disk pairing state (`~/.telecode/run/pairing.json`) is how a HEADLESS daemon's pairing code
 * becomes visible — `telecode service status` reads it. It must round-trip, be owner-only (a pairing
 * code is a credential-in-waiting), and read as absent once expired/corrupt: a stale file from a
 * crashed daemon must never show a dead code.
 */
const STATE = {
  userCode: 'ABCD-2345',
  verificationUri: 'http://relay.test/activate',
  expiresAt: 1_000_000 + 300_000,
};

describe('pairing state file', () => {
  let home: string;
  let path: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'telecode-pairing-state-'));
    path = resolvePairingStatePath(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('resolves under the run dir', () => {
    expect(path).toBe(join(home, '.telecode', 'run', 'pairing.json'));
  });

  it('round-trips the state', async () => {
    await savePairingState(STATE, path);
    expect(await loadPairingState(path, () => 1_000_000)).toEqual(STATE);
  });

  it('writes the file owner-only and tightens the run dir even when it pre-existed loose', async () => {
    // The single-instance lock creates run/ first (0755); saving the code must retighten it, else
    // another local user could see a pairing is in progress.
    await mkdir(join(home, '.telecode', 'run'), { recursive: true, mode: 0o755 });
    await savePairingState(STATE, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.telecode', 'run'))).mode & 0o777).toBe(0o700);
  });

  it('reads as absent once expired (a dead code must never be shown)', async () => {
    await savePairingState(STATE, path);
    expect(await loadPairingState(path, () => STATE.expiresAt + 1)).toBeNull();
  });

  it('reads as absent when the file is missing', async () => {
    expect(await loadPairingState(path, () => 0)).toBeNull();
  });

  it('reads as absent when the file is corrupt', async () => {
    await savePairingState(STATE, path);
    await writeFile(path, 'not-json{');
    expect(await loadPairingState(path, () => 0)).toBeNull();
  });

  it('clear removes the file and tolerates it being already gone', async () => {
    await savePairingState(STATE, path);
    await clearPairingState(path);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
    await clearPairingState(path); // idempotent
  });
});
