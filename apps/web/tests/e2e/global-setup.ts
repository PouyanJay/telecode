import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Boot the relay (with auth + a real database) for the e2e run. Playwright's `webServer` runs the
 * SvelteKit dev server; the relay is spawned here and gated on /healthz. Migrations are applied via the
 * relay's db:migrate CLI (a child process — we deliberately avoid importing the relay's server types
 * into the web's frontend typecheck). Locally the DB URL + secrets come from the repo `.env`; in CI they
 * come from the job environment.
 */
const ROOT = path.resolve(process.cwd(), '../..');
const RELAY_PORT = '8080';
const RELAY_HEALTH = `http://127.0.0.1:${RELAY_PORT}/healthz`;

function loadRepoEnv(): void {
  let text: string;
  try {
    text = readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return; // CI — env comes from the runner.
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    const key = match?.[1];
    if (key && process.env[key] === undefined) {
      process.env[key] = match?.[2] ?? '';
    }
  }
}

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
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`db:migrate exited ${code}`))));
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
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrl,
    CHANNEL_TOKEN_SECRET: channelTokenSecret,
    RELAY_SERVICE_SECRET: serviceSecret,
  });
  await waitForHealth(RELAY_HEALTH);

  return () => {
    relay.kill();
    return Promise.resolve();
  };
}
