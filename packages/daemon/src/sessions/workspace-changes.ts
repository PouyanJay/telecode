import {
  MAX_CHANGED_FILES,
  MAX_CHANGED_FILE_PATH_CHARS,
  type ChangedFile,
} from '@telecode/protocol';

import { runGit } from './run-git';

/**
 * A worktree's diff summary vs the base it was cut from — the payload of `session.changes` minus the
 * fields the daemon stamps (`baseBranch`, `ts`). `files` is clipped to {@link MAX_CHANGED_FILES}
 * (`truncated` says so); the totals always cover the FULL diff.
 */
export interface WorkspaceChangesSummary {
  readonly files: ChangedFile[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  readonly truncated: boolean;
}

/**
 * Computes a session worktree's branch-diff summary vs a base ref (branch-actions, Phase C). A DI seam
 * like `BranchLister`: the daemon depends on this signature, the git implementation below is injected at
 * the composition root, and a missing/failed read resolves `undefined` — the panel just doesn't update;
 * it never fails a session.
 */
export type WorkspaceChangesReader = (
  cwd: string,
  baseRef: string,
) => Promise<WorkspaceChangesSummary | undefined>;

/**
 * Parse one `git diff --numstat` line: `<additions>\t<deletions>\t<path>`. Binary files carry `-` for
 * both counts — reported as `null` (honest "unknowable"), never a fake 0. Overlong paths are clipped to
 * the wire bound (display-only data; the counts stay real).
 */
function parseNumstatLine(line: string): ChangedFile | undefined {
  const [added, deleted, ...pathParts] = line.split('\t');
  const path = pathParts.join('\t');
  if (added === undefined || deleted === undefined || path.length === 0) return undefined;
  const count = (raw: string): number | null => {
    if (raw === '-') return null;
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value >= 0 ? value : null;
  };
  return {
    path: path.slice(0, MAX_CHANGED_FILE_PATH_CHARS),
    additions: count(added),
    deletions: count(deleted),
  };
}

/** Fold the two git outputs into one bounded summary (totals cover the FULL diff; rows clip). */
function summarize(numstat: string, untracked: string): WorkspaceChangesSummary {
  const files: ChangedFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  let clipped = 0;
  const push = (file: ChangedFile): void => {
    if (files.length < MAX_CHANGED_FILES) files.push(file);
    else clipped += 1;
  };
  for (const line of numstat.split('\n')) {
    if (line.length === 0) continue;
    const file = parseNumstatLine(line);
    if (file === undefined) continue;
    totalAdditions += file.additions ?? 0;
    totalDeletions += file.deletions ?? 0;
    push(file);
  }
  for (const path of untracked.split('\n')) {
    if (path.length === 0) continue;
    // Counting an untracked file's lines would mean reading it — `null` is the honest, free answer.
    push({ path: path.slice(0, MAX_CHANGED_FILE_PATH_CHARS), additions: null, deletions: null });
  }
  return { files, totalAdditions, totalDeletions, truncated: clipped > 0 };
}

/**
 * The real reader: working tree vs `merge-base(baseRef, HEAD)`, so uncommitted agent work counts and
 * a base that moved on after the cut never pollutes the summary with other people's changes. Untracked
 * files (agents create files long before anything commits them) are listed too, with `null` counts —
 * read-only honesty; it never mutates the worktree (no `add -N` tricks) and never opens file contents.
 */
export function createGitChangesReader(): WorkspaceChangesReader {
  return async (cwd, baseRef) => {
    try {
      const mergeBase = (await runGit(['-C', cwd, 'merge-base', baseRef, 'HEAD'])).stdout.trim();
      const numstat = (await runGit(['-C', cwd, 'diff', '--numstat', mergeBase])).stdout;
      const untracked = (await runGit(['-C', cwd, 'ls-files', '--others', '--exclude-standard']))
        .stdout;
      return summarize(numstat, untracked);
    } catch {
      // Not a repo, base gone, git missing, timeout — the panel simply doesn't update.
      return undefined;
    }
  };
}
