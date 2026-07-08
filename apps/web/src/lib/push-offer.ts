import type { SessionOrigin, SessionStatusName } from '@telecode/protocol';

/**
 * Whether the rail offers "push for a PR" (branch-actions T6). Mirrors the daemon's own gate:
 * LAUNCHED sessions with a known branch, never mid-turn (a state the agent is half-way through
 * writing must not be published) — but unlike the switch, every SETTLED state qualifies: work on
 * an error/needs_restart branch is often exactly what wants rescuing into a PR. The caller adds
 * the liveness facts (device online, channel up); this is the session-shape half.
 */
export function canPushBranch(
  status: SessionStatusName | undefined,
  origin: SessionOrigin,
  branch: string | undefined,
): boolean {
  if (origin !== 'launched' || branch === undefined || status === undefined) return false;
  return (
    status !== 'starting' &&
    status !== 'running' &&
    status !== 'awaiting_input' &&
    status !== 'offline_paused' &&
    // Between-turns of a LIVE adopted session (adopted-only, so the origin gate above already
    // excludes it) — listed so the status answer stays honest on its own.
    status !== 'waiting_local'
  );
}
