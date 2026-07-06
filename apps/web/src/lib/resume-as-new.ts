import { isSessionEndStatus, type SessionOrigin } from '@telecode/protocol';

import type { SessionStatus } from './session';

/**
 * Whether a session can ONLY continue as a new linked session (ux Phase 6 T8) — the session view then
 * routes its composer to `resumeAsNew` instead of an in-place follow-up:
 *  - `needs_restart` (any origin): the daemon lost the conversation; an in-place follow-up is a dead end.
 *  - a TERMINAL `external` (adopted) session: telecode never drove its run loop, so there is nothing to
 *    follow up in place — a fork into a telecode-owned child is the only way forward.
 * Ended LAUNCHED sessions (done/error/turn_limit) keep their in-place resume — no duplicate affordance.
 */
export function canResumeAsNew(status: SessionStatus, origin: SessionOrigin): boolean {
  if (status === 'needs_restart') return true;
  return origin === 'external' && isSessionEndStatus(status);
}
