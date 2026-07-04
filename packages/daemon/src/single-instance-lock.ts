import { rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A user-scoped single-instance lock (a PID file) so a manual foreground `telecode` and the background
 * login service never both run — two daemons registering as the same device would fight over sessions.
 * A stale lock (its process gone) is reclaimed automatically. `release()` is synchronous so it is safe to
 * call from a process `exit` handler. Liveness + pid are injectable for deterministic tests.
 *
 * Scope: this guards the realistic *sequential* case (the service is already up when a manual run starts,
 * or vice versa). It is not a hardened mutex against two daemons launched in the same instant — for that
 * the relay would still see a duplicate device — which is not a case this feature needs to defend.
 */
interface SingleInstanceLockOptions {
  readonly pidFilePath: string;
  /** This process's pid; defaults to `process.pid`. */
  readonly pid?: number;
  /** Whether a pid belongs to a live process; defaults to a `process.kill(pid, 0)` probe. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

type SingleInstanceLock =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly holderPid: number };

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // POSIX liveness probe: signal 0 checks existence/permission without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM ⇒ the process exists but is owned by another user; anything else ⇒ treat it as gone.
    return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Try to take the lock. Resolves `{ acquired: false, holderPid }` if a live instance already holds it. */
export async function acquireSingleInstanceLock(
  options: SingleInstanceLockOptions,
): Promise<SingleInstanceLock> {
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  let existing: string | null;
  try {
    existing = await readFile(options.pidFilePath, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== null) {
    const holderPid = Number.parseInt(existing.trim(), 10);
    if (Number.isInteger(holderPid) && holderPid !== pid && isProcessAlive(holderPid)) {
      return { acquired: false, holderPid };
    }
  }

  await mkdir(dirname(options.pidFilePath), { recursive: true });
  await writeFile(options.pidFilePath, String(pid), { mode: 0o600 });
  return {
    acquired: true,
    release: () => {
      try {
        rmSync(options.pidFilePath, { force: true });
      } catch {
        // Best-effort: a missing/locked file on shutdown must not throw out of an exit handler.
      }
    },
  };
}
