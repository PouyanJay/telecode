/**
 * Render a systemd `--user` service unit (pure — no filesystem, fully unit-testable as string output).
 * This is the on-disk contract that makes the daemon a Linux login service: `Restart=on-failure`
 * restarts it on crash, `WantedBy=default.target` starts it at login (combined with `loginctl
 * enable-linger` so it survives logout/reboot), and `StandardOutput/Error=append:` capture its logs into
 * the same `~/.telecode/logs` files the launchd service uses, so `telecode service logs` is uniform.
 */
export interface SystemdUnitConfig {
  /** `Description=` line shown by `systemctl status`. */
  readonly description: string;
  /** The command + args systemd execs, e.g. `[nodePath, binPath, '--relay-url', url]`. */
  readonly execStart: readonly string[];
  /** Absolute path stdout is appended to (a plain path — the `append:` directive is not arg-quoted). */
  readonly stdoutPath: string;
  /** Absolute path stderr is appended to (a plain path — the `append:` directive is not arg-quoted). */
  readonly stderrPath: string;
  /** Environment variables to inject — a `--user` service does not source the shell rc. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Seconds to wait before restarting after a crash (default 5). */
  readonly restartSec?: number;
}

/** Double-quote a value for systemd, escaping backslashes and quotes so spaces/specials survive parsing. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Assemble the systemd unit file. */
export function renderSystemdUnit(config: SystemdUnitConfig): string {
  const environmentLines = Object.entries(config.environment ?? {}).map(
    ([key, value]) => `Environment=${quote(`${key}=${value}`)}`,
  );

  return [
    '[Unit]',
    `Description=${config.description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${config.execStart.map(quote).join(' ')}`,
    'Restart=on-failure',
    `RestartSec=${config.restartSec ?? 5}`,
    `StandardOutput=append:${config.stdoutPath}`,
    `StandardError=append:${config.stderrPath}`,
    ...environmentLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
