import type { SessionOrigin } from '@telecode/protocol';

import { canResumeAsNew } from './resume-as-new';
import type { SessionStatus } from './session';

/**
 * What typing into this session's composer DOES right now (adopted-takeover T4/T5):
 *  - `follow_up` — the ordinary in-place send (the page's own busy-gating still applies);
 *  - `takeover` — a LIVE adopted session between turns: sending forks a new linked telecode-owned
 *    session that resumes the conversation (telecode can't type into the local terminal);
 *  - `resume_new` — an ended/lost session that can only continue as a new linked one (ux Phase 6 T8);
 *  - `blocked_local_turn` — an adopted session mid-turn locally: nothing can be sent anywhere, and
 *    the composer must SAY so instead of spinning silently (the reported bug).
 */
export type ComposerMode = 'follow_up' | 'takeover' | 'resume_new' | 'blocked_local_turn';

/** Decide the composer mode from the session's shape; liveness (device/channel) stays with the page. */
export function composerModeFor(
  status: SessionStatus | undefined,
  origin: SessionOrigin,
): ComposerMode {
  if (origin === 'external' && status === 'waiting_local') return 'takeover';
  if (status !== undefined && status !== 'idle' && canResumeAsNew(status, origin)) {
    return 'resume_new';
  }
  if (origin === 'external' && (status === 'running' || status === 'starting')) {
    return 'blocked_local_turn';
  }
  return 'follow_up';
}
