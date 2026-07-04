import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandRunner } from './command-runner';
import { createRecordingRunner } from './fake-command-runner';
import { createLaunchdManager } from './launchd-manager';
import { runServiceCli } from './service-cli';
import type { ServiceManager } from './service-manager';
import { createSystemdManager } from './systemd-manager';

/**
 * Variant coverage (final journey task): the service across both platforms × the edge cases that are not
 * exercised by the per-manager suites — clean uninstall-when-absent, idempotent re-install, and the
 * not-installed status matrix through the CLI. `launchctl`/`systemctl` stay faked; the filesystem is a
 * real temp home.
 */
describe('service variant coverage', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'telecode-svc-var-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const managers: ReadonlyArray<{
    name: string;
    create: (runner: CommandRunner) => ServiceManager;
  }> = [
    {
      name: 'launchd (darwin)',
      create: (runner) =>
        createLaunchdManager({ home, runner, nodePath: '/n', binPath: '/b', uid: 501 }),
    },
    {
      name: 'systemd (linux)',
      create: (runner) => createSystemdManager({ home, runner, nodePath: '/n', binPath: '/b' }),
    },
  ];

  describe.each(managers)('$name', ({ name, create }) => {
    it('uninstall is a clean no-op when nothing is installed', async () => {
      // Arrange
      const { runner } = createRecordingRunner();

      // Act
      const result = await create(runner).uninstall();

      // Assert
      expect(result.ok).toBe(true);
    });

    it('status reports not-installed / not-running on a fresh machine', async () => {
      // Arrange
      const { runner } = createRecordingRunner();

      // Act
      const status = await create(runner).status();

      // Assert
      expect(status.installed).toBe(false);
      expect(status.running).toBe(false);
    });

    it('install is idempotent — a second install still succeeds', async () => {
      // Arrange — launchd needs a fake that models its real "second bootstrap fails unless booted out
      // first" constraint (so the test proves the fix); systemd's `enable --now` is already idempotent,
      // so a plain success-runner is the right sanity check there.
      const runner = name.includes('launchd')
        ? makeBootstrapStateRunner()
        : createRecordingRunner().runner;
      const manager = create(runner);

      // Act + Assert
      expect((await manager.install()).ok).toBe(true);
      expect((await manager.install()).ok).toBe(true);
    });
  });

  it.each([['darwin'], ['linux']] as const)(
    '`service status` reports not-installed on %s',
    async (platform) => {
      // Arrange
      const { runner } = createRecordingRunner();
      const out: string[] = [];

      // Act
      const code = await runServiceCli({
        argv: ['service', 'status'],
        env: {},
        platform,
        home,
        runner,
        uid: 501,
        nodePath: '/n',
        binPath: '/b',
        write: (text) => void out.push(text),
      });

      // Assert
      expect(code).toBe(0);
      expect(out.join('')).toMatch(/installed:\s*no/i);
    },
  );

  it('`service status` reports installed + running on linux after an install', async () => {
    // Arrange — a runner that succeeds for every command and reports the unit active + enabled
    const { runner } = createRecordingRunner((spec) => {
      if (spec.args.includes('is-active'))
        return { ok: true, stdout: 'active\n', stderr: '', code: 0 };
      if (spec.args.includes('is-enabled'))
        return { ok: true, stdout: 'enabled\n', stderr: '', code: 0 };
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    const base = {
      env: {} as NodeJS.ProcessEnv,
      platform: 'linux' as const,
      home,
      runner,
      nodePath: '/n',
      binPath: '/b',
    };
    const out: string[] = [];

    // Act
    await runServiceCli({ ...base, argv: ['service', 'install', '--relay-url', 'wss://r/ws'] });
    await runServiceCli({
      ...base,
      argv: ['service', 'status'],
      write: (text) => void out.push(text),
    });

    // Assert
    expect(out.join('')).toMatch(/installed:\s*yes/i);
    expect(out.join('')).toMatch(/running:\s*yes/i);
  });
});

/**
 * A runner that models the launchd `bootstrap`/`bootout` state machine: a second `bootstrap` of an
 * already-loaded label fails unless it is booted out first. Idempotent install must therefore boot out
 * before bootstrapping. Every other command (including all systemd verbs) just succeeds.
 */
function makeBootstrapStateRunner(): CommandRunner {
  let loaded = false;
  return {
    run(spec) {
      if (spec.args[0] === 'bootstrap') {
        if (loaded) {
          return Promise.resolve({
            ok: false,
            stdout: '',
            stderr: 'Bootstrap failed: 5: Input/output error (already loaded)',
            code: 5,
          });
        }
        loaded = true;
        return Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 });
      }
      if (spec.args[0] === 'bootout') {
        loaded = false;
        return Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 });
      }
      return Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 });
    },
  };
}
