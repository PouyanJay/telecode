import { access } from 'node:fs/promises';

/** True if a path exists on disk. Shared by the repo + worktree managers for their idempotency checks. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
