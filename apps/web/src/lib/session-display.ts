import { type SessionStatus } from './session';

/** The status-dot tones the design system exposes (StatusDot's `tone` prop). */
export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'muted';

export interface StatusDisplay {
  readonly tone: Tone;
  readonly label: string;
  readonly pulse: boolean;
}

/**
 * Single source of truth for how each session status renders — a dot tone + an UPPERCASE mono label
 * (enterprise-ui §status), with a pulse on the live states. Shared by the dashboard list, the session
 * view, and any future surface so a label/tone change is one edit. `awaiting_input` and `running` carry
 * the amber accent (the "live / needs you" signal); everything else stays neutral/semantic.
 */
export const SESSION_DISPLAY: Record<SessionStatus, StatusDisplay> = {
  idle: { tone: 'muted', label: 'IDLE', pulse: false },
  starting: { tone: 'warning', label: 'STARTING…', pulse: false },
  running: { tone: 'accent', label: 'RUNNING', pulse: true },
  awaiting_input: { tone: 'accent', label: 'AWAITING INPUT', pulse: true },
  // The endings read as WHAT happened (ux Phase 6 T2, plan B5) — never one lump "DONE".
  done: { tone: 'success', label: 'COMPLETED', pulse: false },
  error: { tone: 'danger', label: 'FAILED', pulse: false },
  // The run exhausted its turn budget mid-task: settled but followable — a message continues it.
  turn_limit: { tone: 'warning', label: 'ENDED · TURN LIMIT', pulse: false },
  // The daemon lost this conversation (restart/retire): it can only continue as a NEW session.
  needs_restart: { tone: 'warning', label: 'NEEDS RESTART', pulse: false },
  // "PAUSED · OFFLINE", never bare "OFFLINE": that word already means device presence — a paused
  // session and an offline device are different facts and must read differently.
  offline_paused: { tone: 'warning', label: 'PAUSED · OFFLINE', pulse: false },
};
