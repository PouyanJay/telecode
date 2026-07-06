import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPairingPrompt } from './pairing-prompt';
import { loadPairingState, resolvePairingStatePath } from './pairing-state';

/**
 * The pairing prompt is the daemon's one chance to surface the code (P2-2): it must persist the
 * state file (so `telecode service status` can show it to a headless user), keep emitting the
 * structured log line (log-file greps and `.run-state/daemon.log` instructions depend on it), and
 * pretty-print a human block ONLY on an interactive TTY.
 */
const INFO = {
  userCode: 'ABCD-2345',
  verificationUri: 'http://relay.test/activate',
  expiresInSeconds: 300,
};

describe('createPairingPrompt', () => {
  let home: string;
  let statePath: string;
  let logLines: string[];
  let out: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'telecode-prompt-'));
    statePath = resolvePairingStatePath(home);
    logLines = [];
    out = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function prompt(isTty: boolean) {
    return createPairingPrompt({
      pairingStatePath: statePath,
      isTty,
      now: () => 1_000_000,
      write: (text) => void out.push(text),
      logger: pino({ level: 'info' }, { write: (line: string) => void logLines.push(line) }),
    });
  }

  it('persists the state file with the real expiry and logs the structured line', async () => {
    await prompt(false)(INFO);

    expect(await loadPairingState(statePath, () => 1_000_000)).toEqual({
      userCode: 'ABCD-2345',
      verificationUri: 'http://relay.test/activate',
      expiresAt: 1_000_000 + 300 * 1000,
    });
    // The pino line keeps its historical shape — docs + runbooks grep for "enter".
    expect(logLines.some((l) => l.includes('enter ABCD-2345'))).toBe(true);
    // Headless: nothing written to stdout.
    expect(out).toEqual([]);
  });

  it('pretty-prints the code on an interactive TTY (in addition to the log line)', async () => {
    await prompt(true)(INFO);

    const text = out.join('');
    expect(text).toContain('ABCD-2345');
    expect(text).toContain('http://relay.test/activate');
    expect(text).toMatch(/expires in 5 minutes/i);
    expect(logLines.some((l) => l.includes('enter ABCD-2345'))).toBe(true);
  });

  it('uses a singular "minute" when the code expires in one minute', async () => {
    await prompt(true)({ ...INFO, expiresInSeconds: 60 });
    expect(out.join('')).toMatch(/expires in 1 minute\b/);
  });
});
