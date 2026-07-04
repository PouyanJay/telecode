import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pathExists } from '../sessions/path-exists';
import { commandDetail } from './command-detail';
import { resolveLogPaths } from './log-paths';
import { renderSystemdUnit } from './render-systemd-unit';
import type {
  ServiceActionResult,
  ServiceManager,
  ServiceManagerDeps,
  ServiceStatus,
} from './service-manager';

/**
 * Linux login service via a systemd **`--user`** unit (user-scoped — never root, never a system unit).
 * `install` writes the unit to `~/.config/systemd/user/`, reloads, `enable --now`s it, and turns on
 * `loginctl enable-linger` so it keeps running after logout / across reboot without an active session.
 * All `systemctl`/`loginctl` calls go through the injected `CommandRunner` so CI asserts the plan without
 * mutating the OS. Unit rendering is the pure `render-systemd-unit`.
 */
const SERVICE = 'telecode.service';

/** Create the Linux systemd `--user` {@link ServiceManager}. */
export function createSystemdManager(deps: ServiceManagerDeps): ServiceManager {
  const unitDir = join(deps.home, '.config', 'systemd', 'user');
  const unitPath = join(unitDir, SERVICE);
  const { logDir, stdoutPath, stderrPath } = resolveLogPaths(deps.home);
  const systemctl = (...args: string[]) => deps.runner.run({ command: 'systemctl', args });

  async function install(): Promise<ServiceActionResult> {
    try {
      await mkdir(unitDir, { recursive: true });
      await mkdir(logDir, { recursive: true });
      const unit = renderSystemdUnit({
        description: 'telecode daemon — run Claude Code agents on this machine',
        execStart: [deps.nodePath, deps.binPath, ...(deps.daemonArgs ?? [])],
        stdoutPath,
        stderrPath,
        ...(deps.serviceEnv ? { environment: deps.serviceEnv } : {}),
      });
      // 0600: the unit may carry env values — keep it owner-only.
      await writeFile(unitPath, unit, { mode: 0o600 });
      await systemctl('--user', 'daemon-reload');
      const enable = await systemctl('--user', 'enable', '--now', SERVICE);
      if (!enable.ok) {
        return {
          ok: false,
          message: `wrote ${unitPath} but systemctl --user enable failed: ${commandDetail(enable)}`,
        };
      }
      // enable-linger keeps the user service alive after logout / across reboot; some managed hosts
      // restrict it — surface a note but keep the install successful (it still runs while logged in).
      const linger = await deps.runner.run({ command: 'loginctl', args: ['enable-linger'] });
      const note = linger.ok
        ? ''
        : ' (note: could not enable linger — the service may stop at logout; see the docs)';
      return {
        ok: true,
        message: `installed — the telecode daemon will start at login (${unitPath})${note}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `install failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async function uninstall(): Promise<ServiceActionResult> {
    try {
      // Best-effort disable: harmless if it was never enabled. Linger is intentionally left as-is — it
      // is a user-global setting other services may rely on.
      await systemctl('--user', 'disable', '--now', SERVICE);
      await rm(unitPath, { force: true });
      await systemctl('--user', 'daemon-reload');
      return { ok: true, message: `uninstalled — removed ${unitPath}` };
    } catch (err) {
      return {
        ok: false,
        message: `uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async function start(): Promise<ServiceActionResult> {
    if (!(await pathExists(unitPath))) {
      return { ok: false, message: 'not installed — run `telecode service install` first' };
    }
    const result = await systemctl('--user', 'start', SERVICE);
    return result.ok
      ? { ok: true, message: 'started — the telecode daemon is running' }
      : { ok: false, message: `systemctl --user start failed: ${commandDetail(result)}` };
  }

  async function stop(): Promise<ServiceActionResult> {
    const result = await systemctl('--user', 'stop', SERVICE);
    return result.ok
      ? { ok: true, message: 'stopped — starts again at next login or `telecode service start`' }
      : { ok: false, message: `systemctl --user stop failed: ${commandDetail(result)}` };
  }

  async function status(): Promise<ServiceStatus> {
    const installed = await pathExists(unitPath);
    let running = false;
    let enabled = false;
    if (installed) {
      // is-active/is-enabled print the state on stdout ('active'/'enabled'); the exit code mirrors it.
      running = (await systemctl('--user', 'is-active', SERVICE)).stdout.trim() === 'active';
      enabled = (await systemctl('--user', 'is-enabled', SERVICE)).stdout.trim() === 'enabled';
    }
    return { installed, running, enabled, logPath: stdoutPath, unitPath };
  }

  return { platform: 'linux', install, uninstall, start, stop, status };
}
