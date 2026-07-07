import { runGit } from './run-git';

/** How a switch attempt settled at the git layer — the daemon maps this straight onto the wire. */
export type BranchSwitchResult =
  | { ok: true }
  | { ok: false; code: 'dirty' | 'not-found' | 'checked-out-elsewhere' | 'failed' };

/**
 * Checks a session worktree out onto another EXISTING local branch (branch-actions T4). A DI seam
 * like `WorkspaceReaper`. Refusals are its own coded stories, never raw git stderr (which can carry
 * local paths): a missing branch and a dirty tree are pre-checked; git's one remaining refusal —
 * the branch is held by another worktree, usually the user's own checkout — is recognized from its
 * message shape and coded, everything else stays the generic `failed`.
 */
export type BranchSwitcher = (cwd: string, branch: string) => Promise<BranchSwitchResult>;

export function createGitBranchSwitcher(): BranchSwitcher {
  return async (cwd, branch) => {
    try {
      try {
        await runGit(['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      } catch {
        return { ok: false, code: 'not-found' };
      }
      // Uncommitted work is never moved under the agent's feet — the user settles it first.
      const status = await runGit(['-C', cwd, 'status', '--porcelain']);
      if (status.stdout.trim().length > 0) return { ok: false, code: 'dirty' };
      await runGit(['-C', cwd, 'checkout', branch]);
      return { ok: true };
    } catch (err) {
      if (
        err instanceof Error &&
        /already checked out|already used by worktree/i.test(err.message)
      ) {
        return { ok: false, code: 'checked-out-elsewhere' };
      }
      return { ok: false, code: 'failed' };
    }
  };
}
