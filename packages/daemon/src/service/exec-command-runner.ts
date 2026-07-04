import { execFile } from 'node:child_process';

import type { CommandRunner } from './command-runner';

/**
 * The real {@link CommandRunner}: runs the platform service tool via `execFile` (argv form — no shell,
 * so no injection surface) and resolves a result instead of rejecting on a non-zero exit, so a manager
 * can inspect `ok`/`stderr` and decide. Bound at the composition root; tests use a fake instead.
 */
export function createExecCommandRunner(): CommandRunner {
  return {
    run(spec) {
      return new Promise((resolve) => {
        execFile(spec.command, [...spec.args], { encoding: 'utf8' }, (error, stdout, stderr) => {
          // `execFile`'s error carries a numeric `code` only on a non-zero exit; ENOENT has none.
          const code = !error ? 0 : typeof error.code === 'number' ? error.code : null;
          resolve({ ok: !error, stdout, stderr, code });
        });
      });
    },
  };
}
