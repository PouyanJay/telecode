import { dev } from '$app/environment';

interface PairingInstructions {
  /** Shell command a user runs to start their local agent daemon. */
  readonly command: string;
  /**
   * Where the daemon's pairing code appears when {@link command} does not print
   * it to the screen itself — `null` when the command shows the code directly.
   */
  readonly codeLocation: string | null;
}

/**
 * How a user starts their local agent daemon and where to read its pairing code.
 *
 * `npx @telecode/cli` is the published one-liner for a paired machine. In a dev
 * build there's no published bin to run, so the daemon is started by the repo's
 * `make run`, which writes its pairing code to the daemon log rather than printing
 * it on screen. Surfacing the right instruction per environment keeps the pairing
 * screens honest.
 */
export const pairingInstructions: PairingInstructions = dev
  ? { command: 'make run', codeLocation: '.run-state/daemon.log' }
  : { command: 'npx @telecode/cli', codeLocation: null };
