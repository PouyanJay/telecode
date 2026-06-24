import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/**
 * Boot the relay + daemon for the e2e run. Playwright's `webServer` polls an HTTP port, which the
 * daemon (a ws client) doesn't have — so we spawn both here as single `tsx` processes (clean to
 * kill) and gate readiness on the relay's /healthz and the daemon's "registered" log line.
 */

const ROOT = path.resolve(process.cwd(), '../..');
const RELAY_PORT = '8080';
const RELAY_HEALTH = `http://127.0.0.1:${RELAY_PORT}/healthz`;
const RELAY_WS = `ws://127.0.0.1:${RELAY_PORT}/ws`;

function runTs(relativePath: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, relativePath)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function waitForLog(child: ChildProcess, needle: string, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes(needle)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`process exited early (code ${code}) before "${needle}"`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for log "${needle}"`));
    }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    }
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // The Phase 0 echo walking skeleton runs the relay in echo-only mode (no DB, no auth). Empty values
  // override any repo `.env` so the tokenless echo browser is not rejected; the authenticated session
  // flow gets its own e2e with the real web UI.
  const relay = runTs('apps/relay/src/main.ts', {
    RELAY_PORT,
    LOG_LEVEL: 'error',
    DATABASE_URL: '',
    CHANNEL_TOKEN_SECRET: '',
    RELAY_SERVICE_SECRET: '',
  });
  await waitForHealth(RELAY_HEALTH);

  const daemon = runTs('packages/daemon/src/main.ts', {
    TELECODE_RELAY_URL: RELAY_WS,
    TELECODE_USER_ID: 'u_dev',
    TELECODE_DEVICE_ID: 'd_dev',
    LOG_LEVEL: 'info',
  });
  await waitForLog(daemon, 'registered with relay');

  return async () => {
    daemon.kill();
    relay.kill();
  };
}
