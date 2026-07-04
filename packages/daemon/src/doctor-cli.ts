import { homedir } from 'node:os';
import { join } from 'node:path';

import { readHooksStatus } from './adopt/hooks-status';
import { loadCredentials } from './credentials';
import { formatDoctorReport, runDoctor, type DoctorDeps } from './doctor';
import { resolveRelayUrl } from './relay-url';
import { createExecCommandRunner } from './service/exec-command-runner';
import { selectServiceManager } from './service/select-service-manager';

/**
 * The `telecode doctor` CLI entry: binds the pure {@link runDoctor} to real probes (a network health
 * check, the on-disk credential store, the running Node version), prints the report, and returns a process
 * exit code (0 = all good, 1 = at least one failure). Kept thin so the diagnostic logic stays unit-tested.
 */
const PROBE_TIMEOUT_MS = 4000;

async function probeRelay(healthUrl: string): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export interface DoctorCliOptions {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Sink for the rendered report; defaults to stdout. Injected in tests. */
  readonly write?: (text: string) => void;
}

/** Run the doctor command and return the intended process exit code. */
export async function runDoctorCli(options: DoctorCliOptions): Promise<number> {
  const write = options.write ?? ((text: string): void => void process.stdout.write(text));

  let relay: DoctorDeps['relay'];
  try {
    relay = { url: resolveRelayUrl(options.argv, options.env) };
  } catch (err) {
    relay = { error: err instanceof Error ? err.message : 'could not resolve relay URL' };
  }

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const report = await runDoctor({
    nodeVersion: process.versions.node,
    env: options.env,
    relay,
    loadCredentials: () => loadCredentials(),
    probeRelay,
    adoptionHooks: () => readHooksStatus({ settingsPath }),
    serviceStatus: async () => {
      // ServiceManagerDeps is the superset every manager shares; status() reads only the unit/plist and
      // a read-only probe, so the interface-required binPath (an install-time field) is a placeholder here.
      const manager = selectServiceManager(process.platform, {
        home: homedir(),
        runner: createExecCommandRunner(),
        nodePath: process.execPath,
        binPath: process.argv[1] ?? process.execPath,
      });
      return manager ? manager.status() : null;
    },
  });

  write(`${formatDoctorReport(report)}\n`);
  return report.ok ? 0 : 1;
}
