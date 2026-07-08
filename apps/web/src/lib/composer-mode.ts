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

/** The composer's placeholder per mode — one voice for what typing here will do. */
export function composerPlaceholderFor(mode: ComposerMode): string {
  switch (mode) {
    case 'resume_new':
      return 'Continue this work in a new session…';
    case 'takeover':
      return 'Send your next task — it continues here…';
    default:
      return 'Send a follow-up instruction…';
  }
}

/**
 * The composer's honest disabled reason, or undefined when sending is possible. Two cases block:
 * a mid-turn adopted session (nothing can be delivered anywhere — say so instead of spinning
 * silently), and a resume-as-new fork whose chosen branch name isn't valid (the typed message is
 * preserved, never swallowed).
 */
export function composerDisabledReasonFor(
  mode: ComposerMode,
  isForkBranchValid: boolean,
): string | undefined {
  if (mode === 'blocked_local_turn') {
    return 'The agent is working in your terminal — you can take over when this turn finishes.';
  }
  if (mode === 'resume_new' && !isForkBranchValid) {
    return 'Fix the new branch name first — it isn’t a valid git branch name.';
  }
  return undefined;
}
