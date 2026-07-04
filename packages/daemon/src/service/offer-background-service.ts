/**
 * The first-run offer, shown once right after pairing, to host the daemon as a background login service.
 * All effects (prompting, installing, handing off, printing) are injected so the decision matrix is
 * fully testable without touching stdin or the OS. `main.ts` wires the real effects.
 *
 * Flow: silently do nothing on an unsupported platform or when a service is already installed; skip with
 * a hint when we cannot/should not prompt (`--no-service` or a non-interactive stdin); otherwise ask, and
 * on yes install the service and hand off (the foreground exits so the service takes over this session).
 */
export interface BackgroundServiceOffer {
  /** stdin is a TTY, so we can interactively prompt. */
  readonly isInteractive: boolean;
  /** The user passed `--no-service`. */
  readonly noServiceFlag: boolean;
  /** telecode has a login-service implementation for this platform. */
  readonly platformSupported: boolean;
  /** Whether the service is already installed. */
  readonly isInstalled: () => Promise<boolean>;
  /** Ask the user a yes/no question (default yes); resolves the answer. */
  readonly confirm: (question: string) => Promise<boolean>;
  /** Install the service; resolves whether it succeeded. */
  readonly install: () => Promise<boolean>;
  /** Hand off to the service (in production, exit the foreground so the service takes over). */
  readonly handOff: () => void;
  /** Print an informational line for the user. */
  readonly notify: (message: string) => void;
}

const PROMPT = 'Run telecode in the background & start at login? [Y/n]';
const HINT = 'Tip: run `telecode service install` to keep telecode running in the background.';

export async function offerBackgroundService(offer: BackgroundServiceOffer): Promise<void> {
  if (!offer.platformSupported) return;
  if (await offer.isInstalled()) return;
  if (offer.noServiceFlag || !offer.isInteractive) {
    offer.notify(HINT);
    return;
  }

  if (!(await offer.confirm(PROMPT))) {
    offer.notify(HINT);
    return;
  }

  if (await offer.install()) {
    // The installer already printed the confirmation; this adds the distinct hand-off guidance. (Present
    // tense would be premature — the service takes over a moment after the hand-off releases the lock.)
    offer.notify('You can close this terminal — telecode will keep running in the background.');
    offer.handOff();
  } else {
    offer.notify('Background service install failed — continuing in this terminal.');
  }
}
