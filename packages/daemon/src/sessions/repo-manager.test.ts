import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitRepoManager } from './repo-manager';

const run = promisify(execFile);
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A real committed git repo that stands in for the remote (cloned via its local path as the clone URL). */
async function makeSourceRepo(): Promise<string> {
  const dir = await tempDir('telecode-source-');
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.dev']);
  await run('git', ['-C', dir, 'config', 'user.name', 'Telecode Test']);
  await writeFile(join(dir, 'README.md'), '# source\n');
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

describe('RepoManager: clone a GitHub repo on demand', () => {
  it('clones to <reposRoot>/<owner>/<name> and returns the local path', async () => {
    const cloneUrl = await makeSourceRepo();
    const reposRoot = await tempDir('telecode-repos-');
    const manager = createGitRepoManager({ reposRoot });

    const path = await manager.ensureClone({ owner: 'octocat', name: 'hello', cloneUrl });

    expect(path).toBe(join(reposRoot, 'octocat', 'hello'));
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('# source\n');
    // It is a real git repo (a worktree can later be cut from it).
    expect(await exists(join(path, '.git'))).toBe(true);
  });

  it('is idempotent: a second ensure reuses the existing clone and its local state', async () => {
    const cloneUrl = await makeSourceRepo();
    const reposRoot = await tempDir('telecode-repos-');
    const manager = createGitRepoManager({ reposRoot });

    const first = await manager.ensureClone({ owner: 'octocat', name: 'hello', cloneUrl });
    await writeFile(join(first, 'local-change.txt'), 'in progress');

    const second = await manager.ensureClone({ owner: 'octocat', name: 'hello', cloneUrl });

    expect(second).toBe(first);
    // The reuse must not re-clone over local work.
    expect(await readFile(join(second, 'local-change.txt'), 'utf8')).toBe('in progress');
  });

  it('refuses an owner/name that would escape the repos root (path traversal guard)', async () => {
    const cloneUrl = await makeSourceRepo();
    const reposRoot = await tempDir('telecode-repos-');
    const manager = createGitRepoManager({ reposRoot });

    await expect(manager.ensureClone({ owner: '..', name: 'evil', cloneUrl })).rejects.toThrow(
      /repo/i,
    );
  });

  it('surfaces a clear error when the clone source is not a repository', async () => {
    const notARepo = await tempDir('telecode-not-a-repo-');
    const reposRoot = await tempDir('telecode-repos-');
    const manager = createGitRepoManager({ reposRoot });

    await expect(
      manager.ensureClone({ owner: 'octocat', name: 'hello', cloneUrl: notARepo }),
    ).rejects.toThrow(/clone/i);
  });
});
