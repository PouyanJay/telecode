import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    // Arrange
    await writePlist();
    const { runner } = createRecordingRunner(() => failed);

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/kickstart failed/i);
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
    // Arrange
    await writePlist();
    const { runner } = createRecordingRunner(() => failed);

    // Act
    const result = await manager(runner).stop();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/bootout failed/i);
  });
});
