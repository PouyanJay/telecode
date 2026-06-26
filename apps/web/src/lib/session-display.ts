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
  idle: { tone: 'muted', label: 'READY', pulse: false },
  starting: { tone: 'warning', label: 'STARTING…', pulse: false },
  running: { tone: 'accent', label: 'RUNNING', pulse: true },
  awaiting_input: { tone: 'accent', label: 'AWAITING INPUT', pulse: true },
  done: { tone: 'success', label: 'DONE', pulse: false },
  error: { tone: 'danger', label: 'ERROR', pulse: false },
  offline_paused: { tone: 'warning', label: 'OFFLINE', pulse: false },
};
