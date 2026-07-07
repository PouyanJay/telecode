import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitWorktreeManager } from './worktree-manager';
import { createGitWorkspaceReaper } from './workspace-reaper';

const run = promisify(execFile);

/**
 * The reap seam (branch-actions T3), against real worktrees cut by the real manager. Contract:
 * remove worktree + branch on a clean tree, refuse `dirty` (no --force, ever), stay inside its
 * own worktreesRoot no matter what path it is handed, and treat an already-deleted directory as
 * "prune + drop the branch" rather than an error.
 */
describe('createGitWorkspaceReaper', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function makeRepo(): Promise<string> {
    const dir = await tempDir('telecode-reap-repo-');
    await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', dir, 'config', 'user.name', 'telecode-test']);
    await appendFile(join(dir, 'README.md'), '# repo\n');
    await run('git', ['-C', dir, 'add', '.']);
    await run('git', ['-C', dir, 'commit', '-qm', 'init']);
    return dir;
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async function cutWorktree(repo: string): Promise<{ root: string; cwd: string; branch: string }> {
    const root = await tempDir('telecode-reap-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });
    const worktree = await manager.ensureWorktree(randomUUID(), repo);
    return { root, cwd: worktree.path, branch: worktree.branch };
  }

  async function branchExists(repo: string, branch: string): Promise<boolean> {
    const { stdout } = await run('git', ['-C', repo, 'branch', '--list', branch]);
    return stdout.trim().length > 0;
  }

  it('removes a clean worktree and its branch', async () => {
    const repo = await makeRepo();
    const { root, cwd, branch } = await cutWorktree(repo);
    const reaper = createGitWorkspaceReaper({ worktreesRoot: root });

    expect(await reaper({ cwd, repoPath: repo, branch })).toEqual({ ok: true });
    expect(await exists(cwd)).toBe(false);
    expect(await branchExists(repo, branch)).toBe(false);
    const list = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
    expect(list.stdout).not.toContain(cwd);
  });

  it('refuses a dirty tree with the coded story — uncommitted work is never discarded', async () => {
    const repo = await makeRepo();
    const { root, cwd, branch } = await cutWorktree(repo);
    await appendFile(join(cwd, 'README.md'), 'uncommitted\n');
    const reaper = createGitWorkspaceReaper({ worktreesRoot: root });

    expect(await reaper({ cwd, repoPath: repo, branch })).toEqual({ ok: false, code: 'dirty' });
    expect(await exists(cwd)).toBe(true);
    expect(await branchExists(repo, branch)).toBe(true);
  });

  it('refuses to touch a path outside its own worktreesRoot', async () => {
    const repo = await makeRepo();
    const { branch } = await cutWorktree(repo);
    const otherRoot = await tempDir('telecode-reap-other-root-');
    const reaper = createGitWorkspaceReaper({ worktreesRoot: otherRoot });

    // The repo itself is a real, existing git dir — but it is not ours to remove.
    expect(await reaper({ cwd: repo, repoPath: repo, branch })).toEqual({
      ok: false,
      code: 'failed',
    });
    expect(await exists(repo)).toBe(true);
  });

  it('treats an already-deleted worktree directory as prune + branch drop', async () => {
    const repo = await makeRepo();
    const { root, cwd, branch } = await cutWorktree(repo);
    await rm(cwd, { recursive: true, force: true });
    const reaper = createGitWorkspaceReaper({ worktreesRoot: root });

    expect(await reaper({ cwd, repoPath: repo, branch })).toEqual({ ok: true });
    expect(await branchExists(repo, branch)).toBe(false);
    const list = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
    expect(list.stdout).not.toContain(cwd);
  });
});
