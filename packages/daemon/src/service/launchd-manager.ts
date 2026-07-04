import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Create the macOS launchd {@link ServiceManager}. */
export function createLaunchdManager(deps: ServiceManagerDeps): ServiceManager {
  const launchAgentsDir = join(deps.home, 'Library', 'LaunchAgents');
  const plistPath = join(launchAgentsDir, `${LABEL}.plist`);
  const logDir = join(deps.home, '.telecode', 'logs');
  const stdoutPath = join(logDir, 'daemon.log');
  const stderrPath = join(logDir, 'daemon.err.log');
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;

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
      const detail = result.stderr.trim() || `exit ${result.code}`;
      return { ok: false, message: `wrote ${plistPath} but launchctl bootstrap failed: ${detail}` };
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

  async function status(): Promise<ServiceStatus> {
    const installed = await fileExists(plistPath);
    // Running-state detection (parsing `launchctl print`) lands in the launchd-completeness task;
    // for now a present plist is reported as enabled-at-login (the plist always sets RunAtLoad).
    return {
      installed,
      running: false,
      enabled: installed,
      logPath: stdoutPath,
      unitPath: plistPath,
    };
  }

  return { platform: 'darwin', install, uninstall, status };
}
