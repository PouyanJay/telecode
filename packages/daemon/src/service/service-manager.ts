import type { CommandRunner } from './command-runner';

/**
 * The platform-agnostic contract for hosting the telecode daemon as a user-level login service. Each OS
 * is a substitutable implementation (launchd on macOS, systemd `--user` on Linux) selected at the
 * composition root — matching the repo's interface-based DI. Managers only change *how the daemon is
 * hosted*; the daemon binary, the approval gate, and E2E are untouched. Everything stays user-scoped —
 * never root.
 */

/** The runtime state of the login service, as reported by `telecode service status` and `doctor`. */
export interface ServiceStatus {
  /** The unit/plist file is present on disk. */
  readonly installed: boolean;
  /** The service process is currently running. */
  readonly running: boolean;
  /** Registered to start automatically at login. */
  readonly enabled: boolean;
  /** Absolute path to the service log file. */
  readonly logPath: string;
  /** Absolute path to the unit/plist file that defines the service. */
  readonly unitPath: string;
}

/** The outcome of an install/uninstall/start/stop action: success plus a human-readable line for the CLI. */
export interface ServiceActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Hosts the daemon as a user-level login service on one platform. */
export interface ServiceManager {
  /** The platform this manager targets (`'darwin'`, `'linux'`). */
  readonly platform: NodeJS.Platform;
  /** Register the login service (idempotent): write the unit + load it so it starts now and at login. */
  install(): Promise<ServiceActionResult>;
  /** Remove the login service cleanly (idempotent when already absent). */
  uninstall(): Promise<ServiceActionResult>;
  /** (Re)start the service now (it must already be installed). */
  start(): Promise<ServiceActionResult>;
  /** Stop the running service; it stays installed and starts again at next login. */
  stop(): Promise<ServiceActionResult>;
  /** Report installed / running / enabled-at-login and where the log + unit live. */
  status(): Promise<ServiceStatus>;
}

/**
 * Dependencies every {@link ServiceManager} implementation is constructed with, injected at the
 * composition root (`runServiceCli`). It is the superset each OS impl draws from — a manager ignores
 * fields it does not need (e.g. systemd has no use for the macOS `uid` launchd domain).
 */
export interface ServiceManagerDeps {
  /** The user's home directory (injected so tests use a temp dir). */
  readonly home: string;
  /** The OS-command boundary (real `launchctl`/`systemctl` in prod, a recording fake in tests). */
  readonly runner: CommandRunner;
  /** Absolute path to the `node` binary that will run the daemon. */
  readonly nodePath: string;
  /**
   * Absolute path to the telecode bin shim (`bin/telecode.mjs`). Read only when writing the unit/plist
   * during `install` — `status`/`start`/`stop` ignore it, so a probe-only caller may pass a placeholder.
   */
  readonly binPath: string;
  /** The user's numeric uid for the `gui/<uid>` launchd domain; defaults to the current process uid. */
  readonly uid?: number;
  /** Extra daemon args to bake into the service (e.g. `['--relay-url', url]`). */
  readonly daemonArgs?: readonly string[];
  /** Env vars to inject — a GUI login-session service does not source the shell rc. */
  readonly serviceEnv?: Readonly<Record<string, string>>;
}
