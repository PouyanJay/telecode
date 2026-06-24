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
 * `npx telecode` is the eventual published one-liner, but it isn't available in
 * local development yet (no published bin). In a dev build the daemon is started
 * by the repo's `make run`, which writes its pairing code to the daemon log
 * rather than printing it on screen. Surfacing the right instruction per
 * environment keeps the pairing screens honest until the CLI ships.
 */
export const pairingInstructions: PairingInstructions = dev
  ? { command: 'make run', codeLocation: '.run-state/daemon.log' }
  : { command: 'npx telecode', codeLocation: null };
