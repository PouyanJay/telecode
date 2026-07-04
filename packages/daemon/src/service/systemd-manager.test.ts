import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner, CommandSpec } from './command-runner';
import { createRecordingRunner } from './fake-command-runner';
import { createSystemdManager } from './systemd-manager';

/**
 * Manager-level tests for the Linux systemd `--user` service. The unit lives on a REAL temp filesystem;
 * `systemctl`/`loginctl` are a scripted fake so each verb's exact command plan and each state probe is
 * asserted without mutating the OS.
 */
const SERVICE = 'telecode.service';
const ok: CommandResult = { ok: true, stdout: '', stderr: '', code: 0 };
const failed: CommandResult = {
  ok: false,
  stdout: '',
  stderr: 'systemctl: operation failed',
  code: 5,
};

/** Was a command with these exact args planned? */
function planned(calls: CommandSpec[], command: string, args: string[]): boolean {
  return calls.some(
    (c) =>
      c.command === command &&
      c.args.length === args.length &&
      args.every((a, i) => c.args[i] === a),
  );
}

describe('createSystemdManager', () => {
  let home: string;
  let unitPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'telecode-systemd-'));
    unitPath = join(home, '.config', 'systemd', 'user', SERVICE);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeUnit(): Promise<void> {
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(unitPath, '[Unit]\n');
  }

  function manager(runner: CommandRunner, daemonArgs?: readonly string[]) {
    return createSystemdManager({
      home,
      runner,
      nodePath: '/usr/bin/node',
      binPath: '/opt/telecode/bin/telecode.mjs',
      ...(daemonArgs ? { daemonArgs } : {}),
    });
  }

  it('install writes the unit and enables it with lingering', async () => {
    // Arrange
    const { runner, calls } = createRecordingRunner();

    // Act
    const result = await manager(runner).install();

    // Assert
    expect(result.ok).toBe(true);
    const unit = await readFile(unitPath, 'utf8');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('/opt/telecode/bin/telecode.mjs');
    expect(planned(calls, 'systemctl', ['--user', 'daemon-reload'])).toBe(true);
    expect(planned(calls, 'systemctl', ['--user', 'enable', '--now', SERVICE])).toBe(true);
    expect(planned(calls, 'loginctl', ['enable-linger'])).toBe(true);
  });

  it('install bakes the daemon args into the unit', async () => {
    // Arrange
    const { runner } = createRecordingRunner();

    // Act
    await manager(runner, ['--relay-url', 'wss://r/ws']).install();

    // Assert
    const unit = await readFile(unitPath, 'utf8');
    expect(unit).toContain('wss://r/ws');
  });

  it('install fails cleanly when systemctl enable returns non-zero', async () => {
    // Arrange
    const { runner } = createRecordingRunner((spec) =>
      spec.args.includes('enable') ? failed : ok,
    );

    // Act
    const result = await manager(runner).install();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/enable failed/i);
  });

  it('install still succeeds but notes when enable-linger is restricted', async () => {
    // Arrange
    const { runner } = createRecordingRunner((spec) => (spec.command === 'loginctl' ? failed : ok));

    // Act
    const result = await manager(runner).install();

    // Assert — the deliberate design: linger failure is advisory, not fatal
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/linger/i);
  });

  it('uninstall disables the service and removes the unit', async () => {
    // Arrange
    await writeUnit();
    const { runner, calls } = createRecordingRunner();

    // Act
    const result = await manager(runner).uninstall();

    // Assert
    expect(result.ok).toBe(true);
    expect(planned(calls, 'systemctl', ['--user', 'disable', '--now', SERVICE])).toBe(true);
    expect(planned(calls, 'systemctl', ['--user', 'daemon-reload'])).toBe(true);
    await expect(stat(unitPath)).rejects.toThrow();
  });

  it('status reports running + enabled from systemctl probes', async () => {
    // Arrange
    await writeUnit();
    const { runner } = createRecordingRunner((spec) => {
      if (spec.args.includes('is-active'))
        return { ok: true, stdout: 'active\n', stderr: '', code: 0 };
      if (spec.args.includes('is-enabled'))
        return { ok: true, stdout: 'enabled\n', stderr: '', code: 0 };
      return ok;
    });

    // Act
    const status = await manager(runner).status();

    // Assert
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.unitPath).toBe(unitPath);
    expect(status.logPath).toBe(join(home, '.telecode', 'logs', 'daemon.log'));
  });

  it('status reports not-running / not-enabled when systemctl says so', async () => {
    // Arrange
    await writeUnit();
    const { runner } = createRecordingRunner((spec) => {
      if (spec.args.includes('is-active'))
        return { ok: false, stdout: 'inactive\n', stderr: '', code: 3 };
      if (spec.args.includes('is-enabled'))
        return { ok: false, stdout: 'disabled\n', stderr: '', code: 1 };
      return ok;
    });

    // Act
    const status = await manager(runner).status();

    // Assert
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(false);
  });

  it('status does not probe systemctl when the unit is absent', async () => {
    // Arrange
    const { runner, calls } = createRecordingRunner();

    // Act
    const status = await manager(runner).status();

    // Assert
    expect(status.installed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('start drives systemctl --user start when installed', async () => {
    // Arrange
    await writeUnit();
    const { runner, calls } = createRecordingRunner();

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(true);
    expect(planned(calls, 'systemctl', ['--user', 'start', SERVICE])).toBe(true);
  });

  it('start refuses (without touching systemctl) when not installed', async () => {
    // Arrange
    const { runner, calls } = createRecordingRunner();

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/install/i);
    expect(calls).toHaveLength(0);
  });

  it('start surfaces a systemctl failure as a clean non-ok result', async () => {
    // Arrange
    await writeUnit();
    const { runner } = createRecordingRunner(() => failed);

    // Act
    const result = await manager(runner).start();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/start failed/i);
  });

  it('stop drives systemctl --user stop', async () => {
    // Arrange
    const { runner, calls } = createRecordingRunner();

    // Act
    const result = await manager(runner).stop();

    // Assert
    expect(result.ok).toBe(true);
    expect(planned(calls, 'systemctl', ['--user', 'stop', SERVICE])).toBe(true);
  });

  it('stop surfaces a systemctl failure as a clean non-ok result', async () => {
    // Arrange
    const { runner } = createRecordingRunner(() => failed);

    // Act
    const result = await manager(runner).stop();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/stop failed/i);
  });
});
