import { runGit } from './run-git';

/** How a push attempt settled at the git layer — the daemon maps this straight onto the wire. */
export type BranchPushResult =
  | { ok: true; remoteUrl: string }
  | { ok: false; code: 'no-remote' | 'auth' | 'rejected' | 'timeout' | 'failed' };

/**
 * Pushes a session branch to `origin` with the LAPTOP'S OWN git credentials — SSH agent or
 * credential helper, whatever the user's git already trusts; telecode adds no credential of its
 * own (branch-actions T6, plan: "the relay's token never travels"). A DI seam like the other git
 * actions. Refusals are coded from the failure's SHAPE; the raw stderr (which can carry local
 * paths and remote URLs) never leaves this module.
 */
export type BranchPusher = (cwd: string, branch: string) => Promise<BranchPushResult>;

/** A push crosses the network — allow it real time, but never let it wedge a session forever. */
const PUSH_TIMEOUT_MS = 30_000;

export function createGitBranchPusher(): BranchPusher {
  return async (cwd, branch) => {
    let remoteUrl: string;
    try {
      remoteUrl = (await runGit(['-C', cwd, 'remote', 'get-url', 'origin'])).stdout.trim();
    } catch {
      return { ok: false, code: 'no-remote' };
    }
    try {
      await runGit(['-C', cwd, 'push', '--set-upstream', 'origin', branch], {
        timeoutMs: PUSH_TIMEOUT_MS,
      });
      return { ok: true, remoteUrl };
    } catch (err) {
      return { ok: false, code: pushFailureCode(err) };
    }
  };
}

/** Code a push failure from its shape — exported so the mapping itself is testable without a remote. */
export function pushFailureCode(err: unknown): 'auth' | 'rejected' | 'timeout' | 'failed' {
  if (err instanceof Error) {
    if ((err as { killed?: boolean }).killed === true) return 'timeout';
    if (/permission denied|authentication failed|could not read username|403/i.test(err.message)) {
      return 'auth';
    }
    if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/i.test(err.message)) {
      return 'rejected';
    }
  }
  return 'failed';
}
