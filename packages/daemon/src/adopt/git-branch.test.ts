import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitBranchReader } from './git-branch';

const run = promisify(execFile);

/**
 * The REAL reader against a real temp git repo — the seam's one integration test (everything else
 * fakes it). Covers the three answers it can give: a branch name, unknown for detached HEAD, and
 * unknown for a directory that is not a repo at all.
 */
describe('createGitBranchReader', () => {
  let dir: string;
  const readGitBranch = createGitBranchReader();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-git-branch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function git(...args: string[]): Promise<void> {
    await run('git', ['-C', dir, ...args]);
  }

  it('reads the checked-out branch of a real repo', async () => {
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@telecode.local');
    await git('config', 'user.name', 'telecode-test');
    await git('commit', '--allow-empty', '-m', 'root');
    await git('checkout', '-b', 'feature/login');

    expect(await readGitBranch(dir)).toBe('feature/login');
  });

  it('yields unknown for a detached HEAD (a literal HEAD is not a name worth showing)', async () => {
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@telecode.local');
    await git('config', 'user.name', 'telecode-test');
    await git('commit', '--allow-empty', '-m', 'root');
    await git('checkout', '--detach');

    expect(await readGitBranch(dir)).toBeUndefined();
  });

  it('yields unknown for a directory that is not a git repo, and for one that does not exist', async () => {
    expect(await readGitBranch(dir)).toBeUndefined();
    expect(await readGitBranch(join(dir, 'nope'))).toBeUndefined();
  });
});
