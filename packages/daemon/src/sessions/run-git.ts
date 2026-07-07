import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * The one way Phase C code shells out to git (AD-10): execFile with an args ARRAY (no shell, no
 * string interpolation — wire-validated names are defense in depth, this is the floor), a mandatory
 * timeout (a wedged git must never wedge a session), and bounded output (a runaway diff must never
 * balloon memory). Callers own error mapping — git stderr can carry local paths, so whatever they
 * surface must be their OWN coded story, never this raw error. Pre-Phase-C call sites keep their
 * local wrappers by prior decision; new git calls go through here.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 5000;

const DEFAULT_MAX_STDOUT_BYTES = 10 * 1024 * 1024;

export async function runGit(
  args: readonly string[],
  options?: { timeoutMs?: number; maxBufferBytes?: number },
): Promise<{ stdout: string; stderr: string }> {
  return exec('git', [...args], {
    timeout: options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: options?.maxBufferBytes ?? DEFAULT_MAX_STDOUT_BYTES,
  });
}
