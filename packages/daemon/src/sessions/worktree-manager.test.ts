import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitWorktreeManager, WorktreeError } from './worktree-manager';

const run = promisify(execFile);

/** Temp dirs created per test, removed in afterEach so the suite leaves no trace under tmp. */
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A real, committed git repo to cut worktrees from (worktree add needs a resolvable HEAD). */
async function makeRepo(): Promise<string> {
  const dir = await tempDir('telecode-repo-');
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.dev']);
  await run('git', ['-C', dir, 'config', 'user.name', 'Telecode Test']);
  await writeFile(join(dir, 'README.md'), '# repo\n');
  await run('git', ['-C', dir, 'add', '.']);
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WorktreeManager: a git worktree per session off a local repo', () => {
  it('creates a worktree at <root>/<sessionId> on a telecode/<short> branch off the repo', async () => {
    const repoPath = await makeRepo();
    const worktreesRoot = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot });
    const sessionId = randomUUID();

    const worktree = await manager.ensureWorktree(sessionId, repoPath);

    expect(worktree.path).toBe(join(worktreesRoot, sessionId));
    expect(worktree.branch).toBe(`telecode/${sessionId.slice(0, 8)}`);
    // It is a real checkout of the repo, on its own branch.
    expect(await exists(join(worktree.path, 'README.md'))).toBe(true);
    const { stdout: branch } = await run('git', [
      '-C',
      worktree.path,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    expect(branch.trim()).toBe(worktree.branch);
    // Git registers it as a worktree of the repo.
    const { stdout: list } = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    expect(list).toContain(worktree.path);
  });

  it('is idempotent: a second ensure for the same session reuses the worktree and its contents', async () => {
    const repoPath = await makeRepo();
    const worktreesRoot = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot });
    const sessionId = randomUUID();

    const first = await manager.ensureWorktree(sessionId, repoPath);
    await writeFile(join(first.path, 'agent-output.txt'), 'work in progress');

    const second = await manager.ensureWorktree(sessionId, repoPath);

    // Same worktree, same branch — but no `baseBranch`: an existing worktree's cut point isn't
    // recoverable from git, so the reuse path deliberately doesn't guess one (Phase C contract;
    // the daemon keeps the base its record stored at the original cut).
    expect(first.baseBranch).toBe('main');
    expect(second).toEqual({ path: first.path, branch: first.branch });
    // The reuse must not wipe the agent's in-progress work.
    expect(await readFile(join(second.path, 'agent-output.txt'), 'utf8')).toBe('work in progress');
  });

  it('isolates each session in its own worktree (files do not leak across sessions)', async () => {
    const repoPath = await makeRepo();
    const worktreesRoot = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot });
    const sessionA = randomUUID();
    const sessionB = randomUUID();

    const a = await manager.ensureWorktree(sessionA, repoPath);
    const b = await manager.ensureWorktree(sessionB, repoPath);
    await writeFile(join(a.path, 'only-in-a.txt'), 'a');

    expect(b.path).not.toBe(a.path);
    expect(b.branch).not.toBe(a.branch);
    expect(await exists(join(a.path, 'only-in-a.txt'))).toBe(true);
    expect(await exists(join(b.path, 'only-in-a.txt'))).toBe(false);
    expect(await exists(join(repoPath, 'only-in-a.txt'))).toBe(false);
  });

  it('cuts the worktree from a chosen base branch with a chosen name (branch-launch T1)', async () => {
    const repo = await makeRepo();
    // A second branch that diverges from main by one file — the proof the base was honored.
    await run('git', ['-C', repo, 'checkout', '-q', '-b', 'develop']);
    await writeFile(join(repo, 'develop-only.txt'), 'on develop\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-q', '-m', 'develop work']);
    await run('git', ['-C', repo, 'checkout', '-q', 'main']);

    const root = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });
    const sessionId = randomUUID();
    const worktree = await manager.ensureWorktree(sessionId, repo, {
      baseBranch: 'develop',
      branchName: 'feat/picked',
    });

    expect(worktree.branch).toBe('feat/picked');
    expect(worktree.baseBranch).toBe('develop'); // the resolved cut point the Changes panel diffs against
    const head = await run('git', ['-C', worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(head.stdout.trim()).toBe('feat/picked');
    expect(await exists(join(worktree.path, 'develop-only.txt'))).toBe(true); // base honored
  });

  it('resolves a base that only exists as a remote-tracking ref (fresh clones)', async () => {
    const origin = await makeRepo();
    await run('git', ['-C', origin, 'checkout', '-q', '-b', 'develop']);
    await writeFile(join(origin, 'develop-only.txt'), 'on develop\n');
    await run('git', ['-C', origin, 'add', '.']);
    await run('git', ['-C', origin, 'commit', '-q', '-m', 'develop work']);
    await run('git', ['-C', origin, 'checkout', '-q', 'main']);

    // A clone has origin/develop but NO local develop — exactly a repo the daemon cloned on demand.
    const cloneParent = await tempDir('telecode-clone-');
    const clone = join(cloneParent, 'clone');
    await run('git', ['clone', '-q', '--', origin, clone]);

    const root = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });
    const worktree = await manager.ensureWorktree(randomUUID(), clone, {
      baseBranch: 'develop',
      branchName: 'feat/from-remote',
    });

    expect(worktree.branch).toBe('feat/from-remote');
    // The REMOTE-TRACKING form is what actually resolved — reported verbatim, `origin/` prefix intact.
    expect(worktree.baseBranch).toBe('origin/develop');
    expect(await exists(join(worktree.path, 'develop-only.txt'))).toBe(true);
  });

  it('reports a detached-HEAD default cut point as the commit id, never the literal "HEAD"', async () => {
    const repo = await makeRepo();
    const sha = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    await run('git', ['-C', repo, 'checkout', '-q', '--detach', sha]);

    const root = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });
    const worktree = await manager.ensureWorktree(randomUUID(), repo);

    // 'HEAD' as a recorded base would be useless for later diffing (the repo's HEAD moves) — the
    // commit id is the durable, honest stand-in when no branch name exists.
    expect(worktree.baseBranch).toBe(sha);
  });

  it('reuse reports the branch the worktree is ACTUALLY on — later options never win', async () => {
    const repo = await makeRepo();
    const root = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });
    const sessionId = randomUUID();

    const first = await manager.ensureWorktree(sessionId, repo, { branchName: 'feat/original' });
    expect(first.branch).toBe('feat/original');
    // A relaunch with DIFFERENT options must not lie about (or move) the existing checkout.
    const second = await manager.ensureWorktree(sessionId, repo, { branchName: 'feat/other' });
    expect(second.branch).toBe('feat/original');
    expect(second.path).toBe(first.path);
  });

  it('a colliding branch name fails with a coded, human-readable error (branch-launch T3)', async () => {
    const repo = await makeRepo();
    await run('git', ['-C', repo, 'branch', 'taken']);
    const root = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });

    const attempt = manager.ensureWorktree(randomUUID(), repo, { branchName: 'taken' });
    const err = await attempt.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(err).toBeInstanceOf(WorktreeError);
    expect((err as WorktreeError).code).toBe('branch-exists');
    expect((err as WorktreeError).message).toContain('taken');
  });

  it('a missing base fails with a coded, human-readable error', async () => {
    const repo = await makeRepo();
    const root = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });

    const attempt = manager.ensureWorktree(randomUUID(), repo, { baseBranch: 'no-such-branch' });
    const err = await attempt.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(err).toBeInstanceOf(WorktreeError);
    expect((err as WorktreeError).code).toBe('base-not-found');
    expect((err as WorktreeError).message).toContain('no-such-branch');
  });

  it('surfaces a clear error when the repo path is not a git repository', async () => {
    const repoPath = await tempDir('telecode-not-a-repo-');
    const worktreesRoot = await tempDir('telecode-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot });

    await expect(manager.ensureWorktree(randomUUID(), repoPath)).rejects.toThrow(/worktree/i);
  });
});
