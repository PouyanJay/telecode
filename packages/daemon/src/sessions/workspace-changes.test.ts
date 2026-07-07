import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { MAX_CHANGED_FILES } from '@telecode/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createGitChangesReader } from './workspace-changes';

const run = promisify(execFile);

/**
 * The real git reader behind `session.changes` (branch-actions T2), against throwaway repos — no
 * mocks; the numstat/ls-files parsing is exactly what production runs. The contract: tracked drift
 * vs `merge-base(base, HEAD)` including uncommitted work, untracked files listed with `null` counts
 * (never fake 0s, never `add -N` index mutation), binary counts `null`, bounded output.
 */
describe('createGitChangesReader', () => {
  const tempDirs: string[] = [];
  const reader = createGitChangesReader();

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'telecode-reader-repo-'));
    tempDirs.push(dir);
    await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', dir, 'config', 'user.email', 'test@telecode.local']);
    await run('git', ['-C', dir, 'config', 'user.name', 'telecode-test']);
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
    await run('git', ['-C', dir, 'add', '.']);
    await run('git', ['-C', dir, 'commit', '-qm', 'init']);
    return dir;
  }

  /** Cut a work branch, so `main` can move on independently (the merge-base case). */
  async function onBranch(dir: string, name = 'work'): Promise<void> {
    await run('git', ['-C', dir, 'checkout', '-qb', name]);
  }

  it('reports committed + uncommitted tracked drift vs the merge-base, not vs a moved-on base', async () => {
    const dir = await makeRepo();
    await onBranch(dir);
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n'); // +1 committed
    await run('git', ['-C', dir, 'commit', '-aqm', 'work']);
    // The base moves on AFTER the cut — its new commit must NOT pollute the session's summary.
    await run('git', ['-C', dir, 'checkout', '-q', 'main']);
    await writeFile(join(dir, 'unrelated.txt'), 'base moved\n');
    await run('git', ['-C', dir, 'add', '.']);
    await run('git', ['-C', dir, 'commit', '-qm', 'base moves on']);
    await run('git', ['-C', dir, 'checkout', '-q', 'work']);
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n'); // +1 uncommitted

    const summary = await reader(dir, 'main');
    expect(summary).toEqual({
      files: [{ path: 'a.txt', additions: 2, deletions: 0 }],
      totalAdditions: 2,
      totalDeletions: 0,
      truncated: false,
    });
  });

  it('lists untracked files with null counts, outside the totals', async () => {
    const dir = await makeRepo();
    await onBranch(dir);
    await writeFile(join(dir, 'brand-new.txt'), 'x\ny\n');

    const summary = await reader(dir, 'main');
    expect(summary?.files).toEqual([{ path: 'brand-new.txt', additions: null, deletions: null }]);
    expect(summary?.totalAdditions).toBe(0);
    expect(summary?.totalDeletions).toBe(0);
  });

  it('reports binary changes with null counts (numstat "-")', async () => {
    const dir = await makeRepo();
    await onBranch(dir);
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    await run('git', ['-C', dir, 'add', '.']);
    await run('git', ['-C', dir, 'commit', '-qm', 'binary']);

    const summary = await reader(dir, 'main');
    expect(summary?.files).toEqual([{ path: 'blob.bin', additions: null, deletions: null }]);
    expect(summary?.totalAdditions).toBe(0);
  });

  it('keeps a rename readable (git’s "old => new" form) instead of add+delete noise', async () => {
    const dir = await makeRepo();
    await onBranch(dir);
    await run('git', ['-C', dir, 'mv', 'a.txt', 'b.txt']);
    await run('git', ['-C', dir, 'commit', '-qm', 'rename']);

    const summary = await reader(dir, 'main');
    expect(summary?.files).toHaveLength(1);
    expect(summary?.files[0]?.path).toContain('=>');
    expect(summary?.files[0]?.path).toContain('b.txt');
  });

  it(`clips the list at ${MAX_CHANGED_FILES} files but keeps the totals over the full diff`, async () => {
    const dir = await makeRepo();
    await onBranch(dir);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < MAX_CHANGED_FILES + 5; i += 1) {
      writes.push(writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'line\n'));
    }
    await Promise.all(writes);
    await run('git', ['-C', dir, 'add', '.']);
    await run('git', ['-C', dir, 'commit', '-qm', 'many files']);

    const summary = await reader(dir, 'main');
    expect(summary?.files).toHaveLength(MAX_CHANGED_FILES);
    expect(summary?.truncated).toBe(true);
    expect(summary?.totalAdditions).toBe(MAX_CHANGED_FILES + 5);
  });

  it('resolves undefined for a directory that is not a git repo (fail-soft)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telecode-not-a-repo-'));
    tempDirs.push(dir);
    expect(await reader(dir, 'main')).toBeUndefined();
  });

  it('resolves undefined when the base ref does not exist (fail-soft)', async () => {
    const dir = await makeRepo();
    expect(await reader(dir, 'no-such-base')).toBeUndefined();
  });
});
