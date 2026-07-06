import type { Logger } from 'pino';

import type { PairDeviceOptions } from './pairing';
import { savePairingState } from './pairing-state';

export interface PairingPromptOptions {
  readonly pairingStatePath: string;
  /** Interactive terminal? Only then is the human-formatted block printed (P2-2). */
  readonly isTty: boolean;
  readonly now?: () => number;
  /** Sink for the pretty block; defaults to stdout. Injected in tests. */
  readonly write?: (text: string) => void;
  readonly logger?: Logger;
}

type OnPrompt = NonNullable<PairDeviceOptions['onPrompt']>;

/**
 * Build the daemon's pairing prompt (composition root seam). Every prompt does three things:
 * persist the state file so `telecode service status` can show a headless daemon's code, keep the
 * structured pino line (log-file greps and runbooks depend on its shape), and — on an interactive
 * TTY only — print a human-formatted block instead of leaving the code buried in JSON.
 */
export function createPairingPrompt(options: PairingPromptOptions): OnPrompt {
  const now = options.now ?? ((): number => Date.now());
  const write = options.write ?? ((text: string): void => void process.stdout.write(text));
  return async ({ userCode, verificationUri, expiresInSeconds }) => {
    await savePairingState(
      { userCode, verificationUri, expiresAt: now() + expiresInSeconds * 1000 },
      options.pairingStatePath,
    );
    options.logger?.info(
      { userCode, verificationUri },
      `Go to ${verificationUri} and enter ${userCode}`,
    );
    if (options.isTty) {
      const minutes = Math.round(expiresInSeconds / 60);
      write(
        [
          '',
          'telecode pairing',
          `  code: ${userCode}`,
          `  approve at: ${verificationUri}`,
          `  expires in ${minutes} minute${minutes === 1 ? '' : 's'}`,
          '',
          '',
        ].join('\n'),
      );
    }
  };
}
