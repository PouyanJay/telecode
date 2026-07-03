import { type AdoptStatePayload } from '@telecode/protocol';

/**
 * The frictionless-setup state the Settings "Adopted sessions" panel renders from the daemon's `adopt.state`:
 *  - `off` — adoption is disabled (telecode isn't touching your Claude Code config).
 *  - `active` — enabled and the hooks are installed (watching your sessions).
 *  - `attention` — enabled but the hooks are NOT installed: the daemon's auto-install failed (fail-soft), so
 *    the UI surfaces it honestly with how to fix it, rather than showing a false "active".
 */
export type AdoptSetupState = 'off' | 'active' | 'attention';

export function resolveAdoptSetupState(state: AdoptStatePayload): AdoptSetupState {
  if (!state.enabled) return 'off';
  return state.hooksInstalled ? 'active' : 'attention';
}
