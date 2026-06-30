import { sep } from 'node:path';

import { type AdoptSettings } from '@telecode/protocol';

/**
 * Decide whether telecode may adopt a Claude Code session running in `cwd`, given the per-machine policy
 * (Journey 3). Adoption is allowed when it is `enabled` AND the project directory is not on the `denylist`.
 * A denylist entry matches its exact directory and everything beneath it (prefix + path separator, so
 * `/a/secret` blocks `/a/secret` and `/a/secret/sub` but NOT the sibling `/a/secret-other`). A session with
 * no `cwd` can't be denylist-matched, so only the `enabled` switch applies. A denied/disabled session is left
 * entirely to Claude Code's own local flow — telecode stays out of it.
 */
export function isAdoptionAllowed(settings: AdoptSettings, cwd: string | undefined): boolean {
  if (!settings.enabled) return false;
  if (cwd === undefined) return true;
  return !settings.denylist.some((entry) => cwd === entry || cwd.startsWith(entry + sep));
}
