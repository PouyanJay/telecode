import type { ConnectionState } from './session-store';

/**
 * The session view's pre-transcript placeholder (ux Phase 5): what to say while a session has no
 * live state yet. The old view could only say "RECONNECTING…" — forever, when the session's device
 * was offline or revoked. This is the honest decision table (plan B5): most specific truth first,
 * and the spinner state exists only while its device is actually reachable. Pure and unit-tested;
 * the view renders it.
 */
export interface SessionPlaceholder {
  /** UPPERCASE-mono eyebrow (the house placeholder style). */
  readonly eyebrow: string;
  readonly message: string;
}

export interface PlaceholderInput {
  /** The aggregate browser↔relay link (the pool's derived state). */
  readonly relayState: ConnectionState;
  /** The session's device name, when resolvable; null otherwise. */
  readonly deviceName: string | null;
  /** True when the session is routed to a device that is no longer in the active fleet. */
  readonly deviceRevoked: boolean;
  /** Whether the session's device is online (per-device channel presence + REST snapshot). */
  readonly deviceOnline: boolean;
  /** True once a healthy restore has waited past its deadline without a transcript. */
  readonly timedOut: boolean;
}

export function resolvePlaceholder(input: PlaceholderInput): SessionPlaceholder {
  // The browser can't reach the relay at all: no device-level claim is possible.
  if (input.relayState === 'error') {
    return {
      eyebrow: 'RELAY OFFLINE',
      message: 'The channel is offline. It will restore when the connection returns.',
    };
  }
  if (input.relayState === 'connecting' || input.relayState === 'idle') {
    return { eyebrow: 'CONNECTING…', message: 'Connecting to the relay.' };
  }
  // Most specific device truth first: a revoked device will never reconnect.
  if (input.deviceRevoked) {
    return {
      eyebrow: 'DEVICE REVOKED',
      message:
        'This session ran on a device that has been revoked — its live transcript is no longer reachable.',
    };
  }
  if (!input.deviceOnline) {
    return {
      eyebrow: 'DEVICE OFFLINE',
      message: input.deviceName
        ? `This session runs on ${input.deviceName}, which isn’t connected. It will restore when the device comes back online.`
        : 'This session’s device isn’t connected. It will restore when the device comes back online.',
    };
  }
  if (input.timedOut) {
    return {
      eyebrow: 'NOT RESPONDING',
      message: input.deviceName
        ? `${input.deviceName} is connected but hasn’t returned this session’s transcript. The session may no longer exist on it.`
        : 'The device is connected but hasn’t returned this session’s transcript. The session may no longer exist on it.',
    };
  }
  return { eyebrow: 'RESTORING…', message: 'Restoring this session’s transcript.' };
}

/** How long a healthy restore may stay silent before the placeholder escalates honestly. */
export const RESTORE_TIMEOUT_MS = 8_000;
