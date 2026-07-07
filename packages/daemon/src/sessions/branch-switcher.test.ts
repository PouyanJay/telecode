import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitBranchSwitcher } from './branch-switcher';
import { createGitWorktreeManager } from './worktree-manager';

const run = promisify(execFile);

/**
 * The switch seam (branch-actions T4), against real worktrees. Contract: move a CLEAN worktree onto
 * an existing local branch; refuse `not-found`/`dirty` with pre-checked stories; recognize git's
 * "held by another worktree" refusal as `checked-out-elsewhere` (raw stderr never escapes).
 */
describe('createGitBranchSwitcher', () => {
  const tempDirs: string[] = [];
  const switcher = createGitBranchSwitcher();

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  /** A repo on `main` plus a spare `feat/other` branch, and one telecode worktree cut from main. */
  async function makeWorkspace(): Promise<{ repo: string; cwd: string }> {
    const repo = await tempDir('telecode-switch-repo-');
    await run('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', repo, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', repo, 'config', 'user.name', 'telecode-test']);
    await writeFile(join(repo, 'README.md'), '# repo\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-qm', 'init']);
    await run('git', ['-C', repo, 'branch', 'feat/other']);
    const root = await tempDir('telecode-switch-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });
    const worktree = await manager.ensureWorktree(randomUUID(), repo);
    return { repo, cwd: worktree.path };
  }

  async function headOf(cwd: string): Promise<string> {
    return (await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  }

  it('checks a clean worktree out onto an existing branch', async () => {
    const { cwd } = await makeWorkspace();
    expect(await switcher(cwd, 'feat/other')).toEqual({ ok: true });
    expect(await headOf(cwd)).toBe('feat/other');
  });

  it('refuses an unknown branch with not-found (HEAD untouched)', async () => {
    const { cwd } = await makeWorkspace();
    const before = await headOf(cwd);
    expect(await switcher(cwd, 'no-such-branch')).toEqual({ ok: false, code: 'not-found' });
    expect(await headOf(cwd)).toBe(before);
  });

  it('refuses a dirty tree — uncommitted work is never moved under the agent', async () => {
    const { cwd } = await makeWorkspace();
    await appendFile(join(cwd, 'README.md'), 'uncommitted\n');
    expect(await switcher(cwd, 'feat/other')).toEqual({ ok: false, code: 'dirty' });
  });

  it('codes a branch held by another worktree as checked-out-elsewhere', async () => {
    const { cwd } = await makeWorkspace();
    // `main` is checked out in the parent repo itself — exactly the user's-own-checkout case.
    expect(await switcher(cwd, 'main')).toEqual({ ok: false, code: 'checked-out-elsewhere' });
  });

  it('codes any other git failure as the generic failed (raw stderr never escapes)', async () => {
    const { repo, cwd } = await makeWorkspace();
    // A corrupt worktree index: `rev-parse` (refs only) still succeeds, `status` dies with a fatal
    // that matches none of the coded shapes — exactly the generic catch-all's territory.
    await writeFile(join(repo, '.git', 'worktrees', basename(cwd), 'index'), 'garbage');
    expect(await switcher(cwd, 'feat/other')).toEqual({ ok: false, code: 'failed' });
  });
});
