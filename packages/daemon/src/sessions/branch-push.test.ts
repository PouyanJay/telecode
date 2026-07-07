import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitBranchPusher, parseGithubRemote, pushFailureCode } from './branch-push';
import { createGitWorktreeManager } from './worktree-manager';

const run = promisify(execFile);

/**
 * The push seam (branch-actions T6), against a REAL local `origin` (a bare repo — the same
 * credential-free transport a filesystem remote gives; the auth/timeout mappings are shape-tested
 * directly since no test should ever talk to a real forge).
 */
describe('createGitBranchPusher', () => {
  const tempDirs: string[] = [];
  const pusher = createGitBranchPusher();

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  /** A bare `origin`, a clone with one commit pushed to it, and a telecode worktree off the clone. */
  async function makeWorkspace(): Promise<{
    origin: string;
    clone: string;
    cwd: string;
    branch: string;
  }> {
    const origin = await tempDir('telecode-push-origin-');
    await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const parent = await tempDir('telecode-push-clone-');
    const clone = join(parent, 'clone');
    await run('git', ['clone', '-q', '--', origin, clone]);
    await run('git', ['-C', clone, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', clone, 'config', 'user.name', 'telecode-test']);
    await appendFile(join(clone, 'README.md'), '# repo\n');
    await run('git', ['-C', clone, 'add', '.']);
    await run('git', ['-C', clone, 'commit', '-qm', 'init']);
    await run('git', ['-C', clone, 'push', '-q', 'origin', 'main']);
    const root = await tempDir('telecode-push-worktrees-');
    const manager = createGitWorktreeManager({ worktreesRoot: root });
    const worktree = await manager.ensureWorktree(randomUUID(), clone);
    return { origin, clone, cwd: worktree.path, branch: worktree.branch };
  }

  it('pushes the session branch to origin and reports the remote URL', async () => {
    const { origin, cwd, branch } = await makeWorkspace();
    await appendFile(join(cwd, 'README.md'), 'session work\n');
    await run('git', ['-C', cwd, 'commit', '-aqm', 'session work']);

    expect(await pusher(cwd, branch)).toEqual({ ok: true, remoteUrl: origin });
    const listed = await run('git', ['-C', origin, 'branch', '--list', branch]);
    expect(listed.stdout).toContain(branch);
  });

  it('codes a repo without an origin as no-remote', async () => {
    const dir = await tempDir('telecode-push-noremote-');
    await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    expect(await pusher(dir, 'main')).toEqual({ ok: false, code: 'no-remote' });
  });

  it('codes a non-fast-forward refusal as rejected', async () => {
    const { origin, cwd, branch } = await makeWorkspace();
    // The remote already holds this branch name pointing at DIVERGED history.
    const other = await tempDir('telecode-push-other-');
    await run('git', ['clone', '-q', '--', origin, join(other, 'c')]);
    const otherClone = join(other, 'c');
    await run('git', ['-C', otherClone, 'config', 'user.email', 'other@telecode.local']);
    await run('git', ['-C', otherClone, 'config', 'user.name', 'other']);
    await appendFile(join(otherClone, 'other.txt'), 'diverged\n');
    await run('git', ['-C', otherClone, 'add', '.']);
    await run('git', ['-C', otherClone, 'commit', '-qm', 'diverged']);
    await run('git', ['-C', otherClone, 'push', '-q', 'origin', `HEAD:${branch}`]);
    // Local session work on the same branch name, without the remote's commit.
    await appendFile(join(cwd, 'README.md'), 'session work\n');
    await run('git', ['-C', cwd, 'commit', '-aqm', 'session work']);

    expect(await pusher(cwd, branch)).toEqual({ ok: false, code: 'rejected' });
  });
});

describe('pushFailureCode', () => {
  it('codes the recognizable failure shapes and defaults to failed', () => {
    const killed = Object.assign(new Error('timed out'), { killed: true });
    expect(pushFailureCode(killed)).toBe('timeout');
    expect(pushFailureCode(new Error('git@github.com: Permission denied (publickey).'))).toBe(
      'auth',
    );
    expect(pushFailureCode(new Error('remote: Authentication failed'))).toBe('auth');
    expect(pushFailureCode(new Error('! [rejected] main -> main (non-fast-forward)'))).toBe(
      'rejected',
    );
    expect(pushFailureCode(new Error('something else entirely'))).toBe('failed');
    expect(pushFailureCode('not even an error')).toBe('failed');
  });
});

describe('parseGithubRemote', () => {
  it('parses the three github.com remote forms, with or without .git', () => {
    expect(parseGithubRemote('git@github.com:acme/app.git')).toBe('acme/app');
    expect(parseGithubRemote('https://github.com/acme/app')).toBe('acme/app');
    expect(parseGithubRemote('https://github.com/acme/app.git')).toBe('acme/app');
    expect(parseGithubRemote('ssh://git@github.com/acme/app.git')).toBe('acme/app');
  });

  it('answers undefined for anything else — no PR link the browser cannot open', () => {
    expect(parseGithubRemote('/Users/dev/repos/app')).toBeUndefined();
    expect(parseGithubRemote('git@gitlab.example.com:acme/app.git')).toBeUndefined();
    expect(parseGithubRemote('https://github.com/acme')).toBeUndefined();
    expect(parseGithubRemote('https://github.com.evil.example/acme/app')).toBeUndefined();
  });
});
