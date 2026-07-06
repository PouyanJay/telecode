import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

import { loadRepoEnv, REPO_ROOT } from './env';

/**
 * Boot the relay (with auth + a real database) for the e2e run. Playwright's `webServer` runs the
 * SvelteKit dev server; the relay is spawned here and gated on /healthz. Migrations are applied via the
 * relay's db:migrate CLI (a child process — we deliberately avoid importing the relay's server types
 * into the web's frontend typecheck). Locally the DB URL + secrets come from the repo `.env`; in CI they
 * come from the job environment. The session e2e pairs its own device + fake daemon in its own setup.
 */
const ROOT = REPO_ROOT;
const RELAY_PORT = '8080';
const RELAY_HEALTH = `http://127.0.0.1:${RELAY_PORT}/healthz`;

function runTs(relativePath: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, relativePath)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function migrate(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@telecode/relay', 'db:migrate'], {
      cwd: ROOT,
      env: process.env,
      stdio: 'ignore',
    });
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`db:migrate exited ${code}`)),
    );
    child.once('error', reject);
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

export default async function globalSetup(): Promise<() => Promise<void>> {
  loadRepoEnv();
  const databaseUrl = process.env.DATABASE_URL;
  const channelTokenSecret = process.env.CHANNEL_TOKEN_SECRET;
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!databaseUrl || !channelTokenSecret || !serviceSecret) {
    throw new Error(
      'e2e requires DATABASE_URL, CHANNEL_TOKEN_SECRET, RELAY_SERVICE_SECRET (load .env or set them)',
    );
  }

  await migrate();

  const relay = runTs('apps/relay/src/main.ts', {
    RELAY_PORT,
    // Overridable so a flaky run can be diagnosed from the relay's own logs (E2E_RELAY_LOG_FILE tees
    // them to a file; default keeps the run quiet exactly as before).
    LOG_LEVEL: process.env.E2E_RELAY_LOG_LEVEL ?? 'error',
    // The whole suite calls from 127.0.0.1 and was already brushing the default 300-requests/minute
    // per-IP budget; one more page load per run tripped it, and a tripped limiter cascades (the /ws
    // upgrade 429s, SSR auth 429s bounce to /signin, reconnects keep the budget saturated). This
    // suite tests functionality — abuse prevention has its own integration tests (rate-limit*.test.ts),
    // and production exempts the web tier's aggregated egress via RATELIMIT_ALLOWLIST the same way.
    RATELIMIT_DISABLED: 'true',
    DATABASE_URL: databaseUrl,
    CHANNEL_TOKEN_SECRET: channelTokenSecret,
    RELAY_SERVICE_SECRET: serviceSecret,
  });
  if (process.env.E2E_RELAY_LOG_FILE) {
    const sink = createWriteStream(process.env.E2E_RELAY_LOG_FILE, { flags: 'a' });
    relay.stdout?.pipe(sink);
    relay.stderr?.pipe(sink);
  }
  await waitForHealth(RELAY_HEALTH);

  return () => {
    relay.kill();
    return Promise.resolve();
  };
}
