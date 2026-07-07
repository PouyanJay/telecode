import { execFile } from 'node:child_process';

/**
 * Reads the current git branch of a working directory; `undefined` when unknown (not a git repo,
 * detached HEAD, git missing, or timeout). The daemon consumes this behind an injectable seam so
 * tests never spawn git. A branch name is workspace CONTENT — callers keep it sealed on the wire
 * and out of logs (AD-6 lineage).
 */
export type BranchReader = (cwd: string) => Promise<string | undefined>;

const GIT_TIMEOUT_MS = 2_000;

export function createGitBranchReader(): BranchReader {
  return (cwd) =>
    new Promise((resolve) => {
      // Array args, no shell — the cwd comes from hook events (user-controlled input).
      execFile(
        'git',
        ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { timeout: GIT_TIMEOUT_MS },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          const branch = stdout.trim();
          // Detached HEAD reports the literal 'HEAD' — an unknown, not a name worth showing.
          resolve(branch === '' || branch === 'HEAD' ? undefined : branch);
        },
      );
    });
}
