import { homedir } from 'node:os';

import { resolveRelayUrl } from '../relay-url';
import type { CommandRunner } from './command-runner';
import { createExecCommandRunner } from './exec-command-runner';
import { selectServiceManager } from './select-service-manager';
import type { ServiceStatus } from './service-manager';

/**
 * The `telecode service <install|uninstall|status>` entry: dispatches to the selected
 * {@link import('./service-manager').ServiceManager} and returns a process exit code. Kept thin — the
 * platform logic stays unit-tested — mirroring `runDoctorCli`.
 */
export interface ServiceCliOptions {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Host platform; defaults to `process.platform`. Injected in tests. */
  readonly platform?: NodeJS.Platform;
  /** Home directory; defaults to `os.homedir()`. Injected in tests. */
  readonly home?: string;
  /** OS-command boundary; defaults to the real `execFile` runner. Injected in tests. */
  readonly runner?: CommandRunner;
  /** `node` binary path; defaults to `process.execPath`. */
  readonly nodePath?: string;
  /** telecode bin path; defaults to `process.argv[1]`. */
  readonly binPath?: string;
  /** Numeric uid for the launchd `gui/<uid>` domain; defaults to the current process uid. */
  readonly uid?: number;
  /** Env vars to inject into the service process. */
  readonly serviceEnv?: Readonly<Record<string, string>>;
  /** Sink for output; defaults to stdout. Injected in tests. */
  readonly write?: (text: string) => void;
}

const USAGE = 'usage: telecode service <install|uninstall|status>';

function formatStatus(status: ServiceStatus): string {
  const lines = ['telecode background service', `  installed: ${status.installed ? 'yes' : 'no'}`];
  if (status.installed) {
    lines.push(
      `  running: ${status.running ? 'yes' : 'no'}`,
      `  enabled at login: ${status.enabled ? 'yes' : 'no'}`,
      `  log: ${status.logPath}`,
      `  unit: ${status.unitPath}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Run the `service` command and return the intended process exit code. */
export async function runServiceCli(options: ServiceCliOptions): Promise<number> {
  const write = options.write ?? ((text: string): void => void process.stdout.write(text));
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const runner = options.runner ?? createExecCommandRunner();
  const nodePath = options.nodePath ?? process.execPath;
  const binPath = options.binPath ?? process.argv[1];

  if (binPath === undefined) {
    write(
      'telecode: cannot determine the daemon path — install globally with `npm i -g @telecode/cli`\n',
    );
    return 1;
  }

  // Resolve the relay URL now and bake it into the service's launch args: a login-session service does
  // not inherit the shell env, so `TELECODE_RELAY_URL` set in a terminal would not otherwise reach it.
  let relayUrl: string;
  try {
    relayUrl = resolveRelayUrl(options.argv, options.env);
  } catch (err) {
    write(`telecode: ${err instanceof Error ? err.message : 'invalid relay URL'}\n`);
    return 1;
  }

  const manager = selectServiceManager(platform, {
    home,
    runner,
    nodePath,
    binPath,
    daemonArgs: ['--relay-url', relayUrl],
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
    ...(options.serviceEnv ? { serviceEnv: options.serviceEnv } : {}),
  });
  if (manager === null) {
    write(
      `telecode service is not yet supported on ${platform} — run \`telecode\` in a terminal for now.\n`,
    );
    return 1;
  }

  switch (options.argv[1]) {
    case 'install': {
      const result = await manager.install();
      write(`${result.message}\n`);
      return result.ok ? 0 : 1;
    }
    case 'uninstall': {
      const result = await manager.uninstall();
      write(`${result.message}\n`);
      return result.ok ? 0 : 1;
    }
    case 'status': {
      write(formatStatus(await manager.status()));
      return 0;
    }
    default:
      write(`${USAGE}\n`);
      return 1;
  }
}
