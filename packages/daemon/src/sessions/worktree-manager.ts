import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { pino, type Logger } from 'pino';

import { pathExists } from './path-exists';

const run = promisify(execFile);

/** Where a session's agent works, and the branch its commits land on — both kept after the session ends. */
export interface SessionWorktree {
  readonly path: string;
  readonly branch: string;
}

/**
 * Gives each session its own git worktree off a local repo so parallel agents never clobber each other's
 * files (plan §2: "each isolated in its own git worktree"). A DI seam like {@link AgentAdapter}: the
 * daemon depends on this interface, the git implementation is injected at the composition root, and tests
 * drive the real thing against a throwaway repo.
 */
export interface WorktreeManager {
  /**
   * Create the worktree for a session off `repoPath` (or return the existing one — idempotent, so a
   * follow-up turn reuses it without disturbing in-progress work). `repoPath` is per call because each
   * session may target a different repo (cloned on demand — Task 8). The worktree and its branch are
   * **kept** when the session ends; nothing here ever removes them (agent work is never auto-deleted).
   */
  ensureWorktree(sessionId: string, repoPath: string): Promise<SessionWorktree>;
}

/** Raised when git fails to prepare a worktree, with the underlying error chained as `cause`. */
export class WorktreeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorktreeError';
  }
}

export interface GitWorktreeManagerOptions {
  /** Directory that holds the per-session worktrees, e.g. `~/.telecode/worktrees` (plan A-3). */
  readonly worktreesRoot: string;
  readonly logger?: Logger;
}

export function createGitWorktreeManager(options: GitWorktreeManagerOptions): WorktreeManager {
  const log = options.logger ?? pino({ name: 'worktree-manager' });
  const worktreesRoot = resolve(options.worktreesRoot);

  return {
    async ensureWorktree(sessionId, repoPath): Promise<SessionWorktree> {
      // Full session id for the directory (collision-free); the plan's short id for the branch label.
      const path = resolve(worktreesRoot, sessionId);
      const branch = `telecode/${sessionId.slice(0, 8)}`;

      // Idempotent: we own `worktreesRoot`, so an existing dir is a worktree we already cut. Returning it
      // (rather than re-adding) lets a follow-up turn reuse the agent's in-progress work untouched.
      if (await pathExists(path)) {
        return { path, branch };
      }

      await mkdir(worktreesRoot, { recursive: true });
      try {
        // `worktree add -b <branch> <path> HEAD`: new branch off the repo's HEAD, checked out at `path`.
        // execFile (not a shell) with an args array — no string interpolation into a command line.
        await run('git', ['-C', resolve(repoPath), 'worktree', 'add', '-b', branch, path, 'HEAD']);
      } catch (cause) {
        throw new WorktreeError(`failed to create git worktree for session ${sessionId}`, {
          cause,
        });
      }
      // Log the branch, never the absolute path (treated as payload-adjacent — kept out of log sinks).
      log.info({ sessionId, branch }, 'worktree-manager: created session worktree');
      return { path, branch };
    },
  };
}
