import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner } from './command-runner';
import { createRecordingRunner } from './fake-command-runner';
import { createLaunchdManager } from './launchd-manager';

/**
 * Manager-level tests for the launchd running-state detection and start/stop verbs. The plist lives on
 * a REAL temp filesystem; `launchctl` is a scripted fake so each verb's exact command plan and each
 * `launchctl print` outcome is asserted without mutating the OS.
 */
const UID = 501;
const LABEL = 'ai.telecode.daemon';

const ok: CommandResult = { ok: true, stdout: '', stderr: '', code: 0 };
const failed: CommandResult = {
  ok: false,
  stdout: '',
  stderr: 'launchctl: operation failed',
  code: 5,
};

describe('createLaunchdManager — running state + start/stop', () => {
  let home: string;
  let plistPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'telecode-launchd-'));
    plistPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writePlist(): Promise<void> {
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plistPath, '<plist/>');
  }

  function manager(runner: CommandRunner) {
    return createLaunchdManager({ home, runner, nodePath: '/n', binPath: '/b', uid: UID });
  }

  it('reports running when launchctl print shows the job in the running state', async () => {
    // Arrange
    await writePlist();
    const { runner, calls } = createRecordingRunner((spec) =>
      spec.args[0] === 'print'
        ? { ok: true, stdout: 'ai.telecode.daemon = {\n\tstate = running\n}', stderr: '', code: 0 }
        : ok,
    );

    // Act
    const status = await manager(runner).status();

    // Assert
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.enabled).toBe(true);
    expect(calls.find((c) => c.args[0] === 'print')?.args).toEqual([
      'print',
      `gui/${UID}/${LABEL}`,
    ]);
  });

  it('reports not-running when launchctl print cannot find the job', async () => {
    // Arrange
    await writePlist();
    const { runner } = createRecordingRunner((spec) =>
      spec.args[0] === 'print'
        ? { ok: false, stdout: '', stderr: 'Could not find service', code: 113 }
        : ok,
    );

    // Act
    const status = await manager(runner).status();

    // Assert
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
  });

  it('does not probe launchctl for running state when the plist is absent', async () => {
    // Arrange
    const { runner, calls } = createRecordingRunner(() => ok);

    // Act
    const status = await manager(runner).status();

    // Assert
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('start kickstarts the job when installed', async () => {
    // Arrange
    await writePlist();
    const { runner, calls } = createRecordingRunner(() => ok);

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.args[0] === 'kickstart')?.args).toEqual([
      'kickstart',
      '-k',
      `gui/${UID}/${LABEL}`,
    ]);
  });

  it('start refuses (without touching launchctl) when the service is not installed', async () => {
    // Arrange
    const { runner, calls } = createRecordingRunner(() => ok);

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/install/i);
    expect(calls).toHaveLength(0);
  });

  it('start surfaces a kickstart failure as a clean non-ok result', async () => {
    // Arrange — the unit IS loaded (print succeeds); the kickstart itself fails
    await writePlist();
    const { runner } = createRecordingRunner((spec) => (spec.args[0] === 'print' ? ok : failed));

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/kickstart failed/i);
  });

  it('start bootstraps the plist when the unit is not loaded (a stopped service must start again)', async () => {
    // Arrange — `launchctl kickstart` cannot start an UNLOADED unit; an unloaded unit must be
    // bootstrapped instead (RunAtLoad starts it as part of loading), else `stop && start` dead-ends.
    await writePlist();
    const { runner, calls } = createRecordingRunner((spec) =>
      spec.args[0] === 'print'
        ? { ok: false, stdout: '', stderr: 'Could not find service', code: 113 }
        : ok,
    );

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.args[0] === 'bootstrap')?.args).toEqual([
      'bootstrap',
      `gui/${UID}`,
      plistPath,
    ]);
    expect(calls.find((c) => c.args[0] === 'kickstart')).toBeUndefined();
  });

  it('start surfaces a bootstrap failure (unloaded unit) as a clean non-ok result', async () => {
    // Arrange — unit not loaded, and the bootstrap that would start it fails
    await writePlist();
    const { runner } = createRecordingRunner((spec) =>
      spec.args[0] === 'print'
        ? { ok: false, stdout: '', stderr: 'Could not find service', code: 113 }
        : failed,
    );

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/bootstrap failed/i);
  });

  it('stop boots the job out of the login domain', async () => {
    // Arrange
    await writePlist();
    const { runner, calls } = createRecordingRunner(() => ok);

    // Act
    const result = await manager(runner).stop();

    // Assert
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.args[0] === 'bootout')?.args).toEqual([
      'bootout',
      `gui/${UID}/${LABEL}`,
    ]);
  });

  it('stop surfaces a bootout failure as a clean non-ok result', async () => {
    // Arrange — the unit IS loaded (print succeeds); the bootout itself fails
    await writePlist();
    const { runner } = createRecordingRunner((spec) => (spec.args[0] === 'print' ? ok : failed));

    // Act
    const result = await manager(runner).stop();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/bootout failed/i);
  });

  it('stop is idempotent: an unloaded unit reports already-stopped without running bootout', async () => {
    // Arrange — `launchctl bootout` hard-fails "No such process" on an unloaded unit; stopping
    // something already stopped must be success, not an error.
    await writePlist();
    const { runner, calls } = createRecordingRunner((spec) =>
      spec.args[0] === 'print'
        ? { ok: false, stdout: '', stderr: 'Could not find service', code: 113 }
        : ok,
    );

    // Act
    const result = await manager(runner).stop();

    // Assert
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/already stopped/i);
    expect(calls.find((c) => c.args[0] === 'bootout')).toBeUndefined();
  });

  it('supports the stop && start sequence from an unloaded unit (the exact live-broken invocation)', async () => {
    // Arrange — the unit is never loaded across the whole sequence
    await writePlist();
    const { runner, calls } = createRecordingRunner((spec) =>
      spec.args[0] === 'print'
        ? { ok: false, stdout: '', stderr: 'Could not find service', code: 113 }
        : ok,
    );
    const m = manager(runner);

    // Act + Assert — both verbs succeed and start bootstraps (not kickstart)
    expect((await m.stop()).ok).toBe(true);
    expect((await m.start()).ok).toBe(true);
    expect(calls.find((c) => c.args[0] === 'bootstrap')).toBeDefined();
  });

  it('install writes the plist and boots out before bootstrapping', async () => {
    // Arrange
    const { runner, calls } = createRecordingRunner();

    // Act
    const result = await manager(runner).install();

    // Assert
    expect(result.ok).toBe(true);
    const plist = await readFile(plistPath, 'utf8');
    expect(plist).toContain(LABEL);
    // Idempotent reload: the bootout must precede the bootstrap.
    const bootoutIndex = calls.findIndex((c) => c.args[0] === 'bootout');
    const bootstrapIndex = calls.findIndex((c) => c.args[0] === 'bootstrap');
    expect(bootoutIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThan(bootoutIndex);
    expect(calls[bootstrapIndex]?.args).toEqual(['bootstrap', `gui/${UID}`, plistPath]);
  });

  it('install surfaces a bootstrap failure as a clean non-ok result', async () => {
    // Arrange — bootstrap fails, bootout (best-effort) succeeds
    const { runner } = createRecordingRunner((spec) =>
      spec.args[0] === 'bootstrap' ? failed : ok,
    );

    // Act
    const result = await manager(runner).install();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/bootstrap failed/i);
  });

  it('uninstall boots out and removes the plist', async () => {
    // Arrange
    await writePlist();
    const { runner, calls } = createRecordingRunner();

    // Act
    const result = await manager(runner).uninstall();

    // Assert
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.args[0] === 'bootout')?.args).toEqual([
      'bootout',
      `gui/${UID}`,
      plistPath,
    ]);
    await expect(stat(plistPath)).rejects.toThrow();
  });
});
