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
   * `options` (branch-launch, Phase B): cut from a chosen BASE branch (default: the repo's HEAD) with
   * a chosen branch NAME (default: the telecode auto-name).
   */
  ensureWorktree(
    sessionId: string,
    repoPath: string,
    options?: WorktreeBranchOptions,
  ): Promise<SessionWorktree>;
}

/** Launch-chosen branch control (both optional — omitted keeps the pre-Phase-B defaults). */
export interface WorktreeBranchOptions {
  /** Existing branch (local, or remote-tracking on a clone) to cut the session branch FROM. */
  readonly baseBranch?: string;
  /** The new session branch's name. */
  readonly branchName?: string;
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

  /** A base the user picked must resolve to a real ref: a local head first, else the clone's remote. */
  async function resolveBase(repoPath: string, baseBranch: string): Promise<string> {
    for (const candidate of [baseBranch, `origin/${baseBranch}`]) {
      try {
        await run('git', [
          '-C',
          repoPath,
          'rev-parse',
          '--verify',
          '--quiet',
          `${candidate}^{commit}`,
        ]);
        return candidate;
      } catch {
        // try the next form
      }
    }
    throw new WorktreeError(`base branch not found: ${baseBranch}`);
  }

  return {
    async ensureWorktree(sessionId, repoPath, options): Promise<SessionWorktree> {
      // Full session id for the directory (collision-free); the plan's short id for the branch label.
      const path = resolve(worktreesRoot, sessionId);
      const branch = options?.branchName ?? `telecode/${sessionId.slice(0, 8)}`;

      // Idempotent: we own `worktreesRoot`, so an existing dir is a worktree we already cut. Report the
      // branch it is ACTUALLY on (a relaunch may pass different options than the original cut).
      if (await pathExists(path)) {
        const head = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
        return { path, branch: head.stdout.trim() };
      }

      const repo = resolve(repoPath);
      const base =
        options?.baseBranch !== undefined ? await resolveBase(repo, options.baseBranch) : 'HEAD';
      await mkdir(worktreesRoot, { recursive: true });
      try {
        // `worktree add -b <branch> <path> <base>`: new branch off the chosen base (default: HEAD),
        // checked out at `path`. execFile (not a shell) with an args array — no string interpolation.
        await run('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, base]);
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
