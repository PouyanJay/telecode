import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { REPO_ROOT } from './env';

/**
 * Spawn the protocol-speaking fake daemon (fake-daemon.ts) as a child process for one paired
 * device, resolving once it has registered with the relay. Shared by every spec that stands in a
 * laptop; `adoptAnnounce` turns on the multi-device announce-and-gate behavior (ux Phase 5).
 */
export interface FakeDaemonOptions {
  readonly userId: string;
  readonly deviceId: string;
  readonly deviceToken: string;
  /** When set, the daemon announces one adopted session with this title and gates it (Phase 5). */
  readonly adoptAnnounce?: string;
  /** Title for the chain-a-takeover parent — pass a per-run unique one (see fake-daemon.ts). */
  readonly chainTitle?: string;
  /**
   * OPT-IN E2E mode (T9): the daemon's X25519 PRIVATE key, base64. Pair the device with the matching
   * public key (see `pairDevice`'s `publicKey` option) so the browser opens an encrypted channel;
   * the daemon itself only ever needs the private half.
   */
  readonly privateKey?: string;
}

export async function spawnFakeDaemon(options: FakeDaemonOptions): Promise<ChildProcess> {
  const relayWs = process.env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(REPO_ROOT, 'apps/web/tests/e2e/fake-daemon.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RELAY_WS_URL: relayWs,
        FAKE_USER_ID: options.userId,
        FAKE_DEVICE_ID: options.deviceId,
        FAKE_DEVICE_TOKEN: options.deviceToken,
        ...(options.adoptAnnounce !== undefined
          ? { FAKE_ADOPT_ANNOUNCE: options.adoptAnnounce }
          : {}),
        ...(options.chainTitle !== undefined ? { FAKE_CHAIN_TITLE: options.chainTitle } : {}),
        ...(options.privateKey !== undefined ? { FAKE_PRIVATE_KEY: options.privateKey } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await waitForReady(child);
  return child;
}

/** Wait until the spawned fake daemon prints its readiness marker (it has registered with the relay). */
function waitForReady(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('fake daemon did not become ready')),
      timeoutMs,
    );
    child.stdout?.on('data', (buf: Buffer) => {
      if (String(buf).includes('fake-daemon: ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (buf: Buffer) => console.error('[fake-daemon]', String(buf).trim()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake daemon exited early (${code})`));
    });
  });
}
