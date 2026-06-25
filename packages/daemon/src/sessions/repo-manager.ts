import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { pino, type Logger } from 'pino';

import { pathExists } from './path-exists';

const run = promisify(execFile);

/** The repo a session targets: its owner/name (the cache key) and public clone URL. */
export interface RepoRef {
  readonly owner: string;
  readonly name: string;
  readonly cloneUrl: string;
}

/**
 * Clones a GitHub repo onto the laptop on demand so a session can run against it (plan §2). A DI seam
 * like {@link WorktreeManager}: the daemon depends on this interface; the git implementation is injected.
 *
 * Trust model (plan A-1): the relay's GitHub token NEVER reaches the daemon. The daemon clones using the
 * laptop's own git credentials (HTTPS credential helper / SSH keys) — `cloneUrl` is just the public clone
 * URL. So a private clone works only if the operator's local git is already authorized for it.
 */
export interface RepoManager {
  /** Clone the repo (or reuse the existing clone — idempotent) and return its local path. */
  ensureClone(repo: RepoRef): Promise<string>;
}

/** Raised when git fails to clone a repo, with the underlying error chained as `cause`. */
export class RepoCloneError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RepoCloneError';
  }
}

export interface GitRepoManagerOptions {
  /** Directory that holds the per-repo clones, e.g. `~/.telecode/repos` (plan A-3). */
  readonly reposRoot: string;
  readonly logger?: Logger;
}

export function createGitRepoManager(options: GitRepoManagerOptions): RepoManager {
  const log = options.logger ?? pino({ name: 'repo-manager' });
  const reposRoot = resolve(options.reposRoot);

  return {
    async ensureClone(repo): Promise<string> {
      const dest = resolve(reposRoot, repo.owner, repo.name);
      // Defense in depth (owner/name are also validated at the wire boundary): never let a crafted
      // owner/name escape the repos root.
      if (dest !== reposRoot && !dest.startsWith(reposRoot + sep)) {
        throw new RepoCloneError(
          `refusing to clone outside the repos root: ${repo.owner}/${repo.name}`,
        );
      }

      // Idempotent: an existing clone is reused as-is so in-progress work is never clobbered.
      // (Refreshing an existing clone with `git fetch` is a later refinement.)
      if (await pathExists(dest)) {
        return dest;
      }

      await mkdir(dirname(dest), { recursive: true });
      try {
        // `clone -- <url> <dest>`: `--` ends option parsing so a `cloneUrl` starting with `-` can't be
        // read as a git flag (option injection); execFile (no shell) handles the rest.
        await run('git', ['clone', '--quiet', '--', repo.cloneUrl, dest]);
      } catch (cause) {
        throw new RepoCloneError(`failed to clone ${repo.owner}/${repo.name}`, { cause });
      }
      // Log owner/name only — never the clone URL (may embed credentials) or the local path.
      log.info({ owner: repo.owner, name: repo.name }, 'repo-manager: cloned repo');
      return dest;
    },
  };
}
