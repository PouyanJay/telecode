/**
 * The single OS-command boundary for the background service managers. Every mutation a `ServiceManager`
 * performs against the platform service tool (`launchctl`, `systemctl`, `loginctl`) goes through this
 * seam so it is injectable — tests bind a fake that records the planned commands (asserting the *plan*
 * without ever running `launchctl` in CI), while `main.ts` binds the real `exec-command-runner`.
 */

/** One command to run: a program plus its argument vector (never a shell string — no injection surface). */
export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** The outcome of a command: whether it exited 0, its captured output, and the exit code. */
export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** Runs a {@link CommandSpec} and resolves its {@link CommandResult}; never rejects on a non-zero exit. */
export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}
