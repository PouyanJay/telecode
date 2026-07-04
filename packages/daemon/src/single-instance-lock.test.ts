import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireSingleInstanceLock } from './single-instance-lock';

/**
 * The single-instance lock keeps a manual foreground `telecode` and the background service from both
 * running as the same device. Tests use a REAL temp PID file and inject `isProcessAlive` so liveness is
 * deterministic — no real process signalling.
 */
describe('acquireSingleInstanceLock', () => {
  let dir: string;
  let pidFilePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-lock-'));
    pidFilePath = join(dir, 'run', 'daemon.pid');
    await mkdir(dirname(pidFilePath), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('acquires when no lock exists, writing the pid, and releases by removing the file', async () => {
    // Arrange + Act
    const lock = await acquireSingleInstanceLock({
      pidFilePath,
      pid: 4242,
      isProcessAlive: () => true,
    });

    // Assert
    if (!lock.acquired) throw new Error('expected the lock to be acquired');
    expect((await readFile(pidFilePath, 'utf8')).trim()).toBe('4242');
    lock.release();
    await expect(readFile(pidFilePath, 'utf8')).rejects.toThrow();
  });

  it('refuses when a live process already holds the lock', async () => {
    // Arrange
    await writeFile(pidFilePath, '999');

    // Act
    const lock = await acquireSingleInstanceLock({
      pidFilePath,
      pid: 4242,
      isProcessAlive: (pid) => pid === 999,
    });

    // Assert
    if (lock.acquired) throw new Error('expected the lock to be refused');
    expect(lock.holderPid).toBe(999);
    // The live holder's pid is left intact.
    expect((await readFile(pidFilePath, 'utf8')).trim()).toBe('999');
  });

  it('reclaims a stale lock whose process is gone', async () => {
    // Arrange
    await writeFile(pidFilePath, '999');

    // Act
    const lock = await acquireSingleInstanceLock({
      pidFilePath,
      pid: 4242,
      isProcessAlive: () => false,
    });

    // Assert
    expect(lock.acquired).toBe(true);
    expect((await readFile(pidFilePath, 'utf8')).trim()).toBe('4242');
  });

  it('reclaims a lock that records this process own pid', async () => {
    // Arrange — a leftover file from a previous run with the same pid (isProcessAlive would say "alive")
    await writeFile(pidFilePath, '4242');

    // Act
    const lock = await acquireSingleInstanceLock({
      pidFilePath,
      pid: 4242,
      isProcessAlive: () => true,
    });

    // Assert — our own pid is never treated as a foreign live holder
    expect(lock.acquired).toBe(true);
  });

  it('acquires when the pid file is malformed', async () => {
    // Arrange
    await writeFile(pidFilePath, 'not-a-pid');

    // Act
    const lock = await acquireSingleInstanceLock({
      pidFilePath,
      pid: 4242,
      isProcessAlive: () => true,
    });

    // Assert — an unparseable holder is not a valid live holder, so we take the lock
    expect(lock.acquired).toBe(true);
    expect((await readFile(pidFilePath, 'utf8')).trim()).toBe('4242');
  });
});
