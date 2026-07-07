import type { SessionOrigin, SessionStatusName } from '@telecode/protocol';

/**
 * Whether the rail offers the between-turns branch switch (branch-actions T4). Mirrors the daemon's
 * own gate so the control never promises what the device would refuse: LAUNCHED sessions only
 * (adopted checkouts are display-only by design), strictly between turns — a settled run a
 * follow-up would continue (`done`, `turn_limit`). Everything else is either mid-turn (running /
 * awaiting a gate) or past following (`error`, `needs_restart`). The caller adds the liveness
 * facts (device online, channel connected) — this is the session-shape half of the decision.
 */
export function canSwitchBranch(
  status: SessionStatusName | undefined,
  origin: SessionOrigin,
): boolean {
  return origin === 'launched' && (status === 'done' || status === 'turn_limit');
}
