import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitBranchLister } from './branch-list';

const run = promisify(execFile);

/** The REAL lister against a real temp repo — the seam's one integration test. */
describe('createGitBranchLister', () => {
  let dir: string;
  const listBranches = createGitBranchLister();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-branch-list-'));
    await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', dir, 'config', 'user.name', 'telecode-test']);
    await run('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'root']);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists local branches with the checked-out one as the default', async () => {
    await run('git', ['-C', dir, 'branch', 'develop']);
    await run('git', ['-C', dir, 'branch', 'feat/login']);

    const result = await listBranches(dir);
    expect(result.branches.sort()).toEqual(['develop', 'feat/login', 'main']);
    expect(result.defaultBranch).toBe('main');
  });

  it('reports no default on a detached HEAD but still lists the branches', async () => {
    await run('git', ['-C', dir, 'checkout', '-q', '--detach']);
    const result = await listBranches(dir);
    expect(result.branches).toEqual(['main']);
    expect(result.defaultBranch).toBeUndefined();
  });

  it('rejects for a directory that is not a git repo (the caller answers unavailable)', async () => {
    await rm(join(dir, '.git'), { recursive: true, force: true });
    await expect(listBranches(dir)).rejects.toThrow();
  });
});
