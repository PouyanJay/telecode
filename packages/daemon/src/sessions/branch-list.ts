import { execFile } from 'node:child_process';

import { MAX_REPO_BRANCHES } from '@telecode/protocol';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Lists a local repo's branches for the launch drawer's base picker (branch-launch Phase B). An
 * injectable seam like {@link BranchReader}: the daemon depends on the type; the git implementation
 * is wired at the composition root and tests fake it. Branch names are workspace CONTENT — the
 * caller seals them to the requesting browser and never logs them.
 */
export interface RepoBranches {
  readonly branches: string[];
  /** The branch HEAD points at (what "cut from the default" means locally); absent when detached. */
  readonly defaultBranch?: string;
}

export type BranchLister = (repoPath: string) => Promise<RepoBranches>;

const GIT_TIMEOUT_MS = 3_000;

export function createGitBranchLister(): BranchLister {
  return async (repoPath) => {
    // Array args, no shell — repoPath comes from daemon config, but the discipline is uniform.
    const heads = await run(
      'git',
      ['-C', repoPath, 'for-each-ref', 'refs/heads', '--format=%(refname:short)'],
      { timeout: GIT_TIMEOUT_MS },
    );
    const branches = heads.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, MAX_REPO_BRANCHES);
    let defaultBranch: string | undefined;
    try {
      const head = await run('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        timeout: GIT_TIMEOUT_MS,
      });
      const name = head.stdout.trim();
      defaultBranch = name === '' || name === 'HEAD' ? undefined : name;
    } catch {
      defaultBranch = undefined; // detached/broken HEAD — the list still stands on its own
    }
    return { branches, ...(defaultBranch !== undefined ? { defaultBranch } : {}) };
  };
}
