import { readFileSync } from 'node:fs';
import { platform, release } from 'node:os';

import { formatOs } from './format-os';

/**
 * Detect this machine's OS descriptor from the real environment (best-effort; never throws). Reported
 * once at pairing; the pure formatting lives in {@link formatOs} (./format-os) so it stays unit-testable.
 */
export function detectOs(): string {
  const currentPlatform = platform();
  let osRelease: string | null = null;
  if (currentPlatform === 'linux') {
    try {
      osRelease = readFileSync('/etc/os-release', 'utf8');
    } catch {
      osRelease = null;
    }
  }
  return formatOs({ platform: currentPlatform, release: release(), osRelease });
}
