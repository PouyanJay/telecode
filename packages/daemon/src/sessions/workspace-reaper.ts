import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { runGit } from './run-git';

/** What a reap attempt came back with — success, or the coded refusal the UI can retell. */
export type WorkspaceReapResult = { ok: true } | { ok: false; code: 'dirty' | 'failed' };

export interface WorkspaceReapArgs {
  /** The session's worktree directory (must live under the reaper's `worktreesRoot`). */
  readonly cwd: string;
  /** The parent repo the worktree was cut from — where `worktree remove`/`branch -D` run. */
  readonly repoPath: string;
  /** The session's own branch, deleted with the worktree. */
  readonly branch: string;
}

/**
 * Removes a session's worktree + branch (branch-actions T3) — the delete flow's explicit opt-in,
 * never automatic. A DI seam like `WorkspaceChangesReader`; the git implementation below is
 * injected at the composition root.
 */
export type WorkspaceReaper = (args: WorkspaceReapArgs) => Promise<WorkspaceReapResult>;

export function createGitWorkspaceReaper(options: { worktreesRoot: string }): WorkspaceReaper {
  const root = resolve(options.worktreesRoot);

  /** Symlink-proof containment: the reaper must never touch anything outside its own root. */
  async function containedTarget(cwd: string): Promise<string | undefined> {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolve(cwd))]);
    const rel = relative(realRoot, realTarget);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return realTarget;
  }

  return async ({ cwd, repoPath, branch }) => {
    let target: string | undefined;
    try {
      target = await containedTarget(cwd);
    } catch {
      // The directory is already gone (manual cleanup, earlier crash) — nothing to contain or
      // refuse. Prune the stale registration and delete the branch; that IS the reap.
      try {
        await runGit(['-C', repoPath, 'worktree', 'prune']);
        await runGit(['-C', repoPath, 'branch', '-D', branch]);
        return { ok: true };
      } catch {
        return { ok: false, code: 'failed' };
      }
    }
    if (target === undefined) return { ok: false, code: 'failed' };
    try {
      // Uncommitted work (tracked or untracked) is never silently discarded — no `--force`, ever;
      // the user goes and looks instead. Committed-but-unmerged work IS discarded: that is what
      // the delete dialog's checkbox explicitly opted into.
      const status = await runGit(['-C', target, 'status', '--porcelain']);
      if (status.stdout.trim().length > 0) return { ok: false, code: 'dirty' };
      await runGit(['-C', repoPath, 'worktree', 'remove', target]);
      await runGit(['-C', repoPath, 'branch', '-D', branch]);
      return { ok: true };
    } catch {
      // Raw git errors can carry local paths — the wire gets the generic code only.
      return { ok: false, code: 'failed' };
    }
  };
}
