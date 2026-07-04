import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { resolveRelayUrl } from '../relay-url';
import type { CommandRunner } from './command-runner';
import { createExecCommandRunner } from './exec-command-runner';
import { selectServiceManager } from './select-service-manager';
import type { ServiceActionResult, ServiceManager, ServiceStatus } from './service-manager';

/**
 * The `telecode service <install|uninstall|start|stop|status|logs>` entry: dispatches to the selected
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

const USAGE = 'usage: telecode service <install|uninstall|start|stop|status|logs>';

// Tail size for `readRecentLogLines` — a bounded read so a large (un-rotated) log never blows memory.
const LOG_TAIL_LINES = 200;

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

async function readRecentLogLines(logPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(logPath, 'utf8');
  } catch {
    return null;
  }
  // Drop a single trailing newline, then treat an empty result (absent content) as "no logs".
  const body = content.replace(/\n$/, '');
  if (body === '') return null;
  return `${body.split('\n').slice(-LOG_TAIL_LINES).join('\n')}\n`;
}

/** Print an action's message and map its outcome to a process exit code. */
function reportAction(result: ServiceActionResult, write: (text: string) => void): number {
  write(`${result.message}\n`);
  return result.ok ? 0 : 1;
}

/** Route a resolved subcommand to the selected manager. */
async function dispatchServiceCommand(
  manager: ServiceManager,
  subcommand: string | undefined,
  write: (text: string) => void,
): Promise<number> {
  switch (subcommand) {
    case 'install':
      return reportAction(await manager.install(), write);
    case 'uninstall':
      return reportAction(await manager.uninstall(), write);
    case 'start':
      return reportAction(await manager.start(), write);
    case 'stop':
      return reportAction(await manager.stop(), write);
    case 'status':
      write(formatStatus(await manager.status()));
      return 0;
    case 'logs': {
      const { logPath } = await manager.status();
      const recent = await readRecentLogLines(logPath);
      write(recent ?? `no logs yet — the service writes to ${logPath}\n`);
      return 0;
    }
    default:
      write(`${USAGE}\n`);
      return 1;
  }
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

  const subcommand = options.argv[1];

  // Only `install` bakes the relay URL into the service (a login-session service does not inherit the
  // shell env, so `TELECODE_RELAY_URL` is captured now). Read-only subcommands must never fail on an
  // unset/invalid URL, so resolution is confined to the install path.
  let daemonArgs: readonly string[] = [];
  if (subcommand === 'install') {
    try {
      daemonArgs = ['--relay-url', resolveRelayUrl(options.argv, options.env)];
    } catch (err) {
      write(`telecode: ${err instanceof Error ? err.message : 'invalid relay URL'}\n`);
      return 1;
    }
  }

  const manager = selectServiceManager(platform, {
    home,
    runner,
    nodePath,
    binPath,
    daemonArgs,
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
    ...(options.serviceEnv ? { serviceEnv: options.serviceEnv } : {}),
  });
  if (manager === null) {
    write(
      `telecode service is not yet supported on ${platform} — run \`telecode\` in a terminal for now.\n`,
    );
    return 1;
  }

  return dispatchServiceCommand(manager, subcommand, write);
}
