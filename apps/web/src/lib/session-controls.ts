import type { SessionOrigin } from '@telecode/protocol';

/** What the session header's operator controls should offer (adopted-takeover T6). */
export interface SessionControls {
  /** Interrupt aborts an in-flight TELECODE-owned turn — an adopted session has none to abort. */
  readonly showInterrupt: boolean;
  readonly showEnd: boolean;
  /** Honest wording: ending an adopted session only stops MIRRORING it — the local process lives on. */
  readonly endLabel: 'End' | 'Stop following';
  /** Hover/assistive elaboration for the adopted case; undefined keeps the launched default. */
  readonly endTitle?: string;
}

/**
 * Decide the header controls from the session's shape. `isBusy`/`isTerminal` carry the page's
 * existing gating (mid-turn / already over); origin decides honesty: an adopted session gets no
 * Interrupt (there is no telecode-owned turn to abort — the button would silently do nothing) and
 * an End that says what it actually does.
 */
export function sessionControlsFor(
  origin: SessionOrigin,
  isBusy: boolean,
  isTerminal: boolean,
): SessionControls {
  const external = origin === 'external';
  return {
    showInterrupt: isBusy && !external,
    showEnd: !isTerminal,
    endLabel: external ? 'Stop following' : 'End',
    ...(external
      ? { endTitle: 'Stops mirroring this terminal session — the local process is untouched.' }
      : {}),
  };
}
