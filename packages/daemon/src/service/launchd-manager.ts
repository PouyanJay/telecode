import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pathExists } from '../sessions/path-exists';
import { commandDetail } from './command-detail';
import { resolveLogPaths } from './log-paths';
import { renderLaunchdPlist } from './render-launchd-plist';
import type {
  ServiceActionResult,
  ServiceManager,
  ServiceManagerDeps,
  ServiceStatus,
} from './service-manager';

/**
 * macOS login service via a launchd **LaunchAgent** (user-scoped — never root). `install` writes the
 * plist to `~/Library/LaunchAgents/` and loads it with `launchctl bootstrap gui/<uid>`; `uninstall`
 * boots it out and removes the plist. All `launchctl` calls go through the injected `CommandRunner` so
 * CI asserts the plan without mutating the OS. Plist rendering is the pure `render-launchd-plist`.
 */
const LABEL = 'ai.telecode.daemon';

/** Create the macOS launchd {@link ServiceManager}. */
export function createLaunchdManager(deps: ServiceManagerDeps): ServiceManager {
  const launchAgentsDir = join(deps.home, 'Library', 'LaunchAgents');
  const plistPath = join(launchAgentsDir, `${LABEL}.plist`);
  const { logDir, stdoutPath, stderrPath } = resolveLogPaths(deps.home);
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${LABEL}`;

  async function install(): Promise<ServiceActionResult> {
    try {
      await mkdir(launchAgentsDir, { recursive: true });
      await mkdir(logDir, { recursive: true });
      const plist = renderLaunchdPlist({
        label: LABEL,
        programArguments: [deps.nodePath, deps.binPath, ...(deps.daemonArgs ?? [])],
        stdoutPath,
        stderrPath,
        ...(deps.serviceEnv ? { environmentVariables: deps.serviceEnv } : {}),
      });
      // 0600: the plist may carry env values — keep it owner-only.
      await writeFile(plistPath, plist, { mode: 0o600 });
      // Boot out any previously-loaded instance first so a re-install — or an updated plist — reloads
      // cleanly instead of failing "already bootstrapped". Best-effort: the result is ignored in ALL
      // cases (it exits non-zero on a first install when nothing is loaded); the bootstrap below surfaces
      // any real failure.
      await deps.runner.run({ command: 'launchctl', args: ['bootout', domain, plistPath] });
      const result = await deps.runner.run({
        command: 'launchctl',
        args: ['bootstrap', domain, plistPath],
      });
      if (result.ok) {
        return {
          ok: true,
          message: `installed — the telecode daemon will start at login (${plistPath})`,
        };
      }
      return {
        ok: false,
        message: `wrote ${plistPath} but launchctl bootstrap failed: ${commandDetail(result)}`,
      };
    } catch (err) {
      // Honour the ServiceActionResult contract — a filesystem error (e.g. EACCES) surfaces as a clean
      // failure line, not an unhandled rejection out of the CLI.
      return {
        ok: false,
        message: `install failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async function uninstall(): Promise<ServiceActionResult> {
    try {
      // Best-effort bootout: harmless if it was never loaded.
      await deps.runner.run({ command: 'launchctl', args: ['bootout', domain, plistPath] });
      await rm(plistPath, { force: true });
      return { ok: true, message: `uninstalled — removed ${plistPath}` };
    } catch (err) {
      return {
        ok: false,
        message: `uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async function start(): Promise<ServiceActionResult> {
    try {
      if (!(await pathExists(plistPath))) {
        return { ok: false, message: 'not installed — run `telecode service install` first' };
      }
      // kickstart -k (re)starts the job now, killing any existing instance first.
      const result = await deps.runner.run({
        command: 'launchctl',
        args: ['kickstart', '-k', serviceTarget],
      });
      return result.ok
        ? { ok: true, message: 'started — the telecode daemon is running' }
        : { ok: false, message: `launchctl kickstart failed: ${commandDetail(result)}` };
    } catch (err) {
      return {
        ok: false,
        message: `start failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async function stop(): Promise<ServiceActionResult> {
    // bootout the service target: unloads the job so KeepAlive cannot restart it. The plist stays on
    // disk, so it comes back at next login or via `telecode service start`.
    const result = await deps.runner.run({
      command: 'launchctl',
      args: ['bootout', serviceTarget],
    });
    return result.ok
      ? { ok: true, message: 'stopped — starts again at next login or `telecode service start`' }
      : { ok: false, message: `launchctl bootout failed: ${commandDetail(result)}` };
  }

  async function status(): Promise<ServiceStatus> {
    const installed = await pathExists(plistPath);
    // `launchctl print <target>` exits non-zero when the job is not loaded; when loaded its output
    // carries a `state = running` line. The plist always sets RunAtLoad, so a present plist is
    // enabled-at-login.
    let running = false;
    if (installed) {
      const printed = await deps.runner.run({
        command: 'launchctl',
        args: ['print', serviceTarget],
      });
      running = printed.ok && /^\s+state\s*=\s*running$/m.test(printed.stdout);
    }
    return {
      installed,
      running,
      enabled: installed,
      logPath: stdoutPath,
      unitPath: plistPath,
    };
  }

  return { platform: 'darwin', install, uninstall, start, stop, status };
}
