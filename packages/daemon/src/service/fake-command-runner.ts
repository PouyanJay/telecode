import type { CommandResult, CommandRunner, CommandSpec } from './command-runner';

/**
 * A recording {@link CommandRunner} for tests: it records every {@link CommandSpec} it is asked to run
 * so a test can assert the planned command vector, and resolves whatever the optional `handler` returns
 * (defaulting to a clean success). This is test support only — excluded from the published package via
 * the `files` allowlist — so the service managers can be driven without ever touching the real OS.
 */
const OK: CommandResult = { ok: true, stdout: '', stderr: '', code: 0 };

export function createRecordingRunner(handler?: (spec: CommandSpec) => CommandResult): {
  runner: CommandRunner;
  calls: CommandSpec[];
} {
  const calls: CommandSpec[] = [];
  const runner: CommandRunner = {
    run(spec) {
      calls.push(spec);
      return Promise.resolve(handler ? handler(spec) : OK);
    },
  };
  return { runner, calls };
}
