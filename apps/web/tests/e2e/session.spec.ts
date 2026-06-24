import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { loadRepoEnv, REPO_ROOT } from './env';

/**
 * The Phase 1 core loop through the real stack (plan §5 exit criteria): from the web app, launch a
 * session on a paired device, watch the agent stream, and approve/reject its actions. A deterministic
 * fake daemon (see fake-daemon.ts) stands in for the laptop — everything else is real: real relay, real
 * Postgres, real browser. The device is paired here via the relay's actual device-grant endpoints so the
 * browser connects on the daemon's `(user_id, device_id)` channel, exactly as in production.
 */
const RELAY_HTTP = process.env.RELAY_HTTP_URL ?? 'http://127.0.0.1:8080';
const RELAY_WS = process.env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';
const DEV_IDENTITY = {
  provider: 'dev',
  providerUserId: 'dev-user',
  displayName: 'Developer',
  email: 'dev@telecode.local',
};

let daemon: ChildProcess | undefined;

/** Pair a device for the dev user via the real device-grant flow; return its id + raw token. */
async function pairDevice(serviceSecret: string): Promise<{
  userId: string;
  deviceId: string;
  deviceToken: string;
}> {
  const svc = { 'content-type': 'application/json', 'x-telecode-service-secret': serviceSecret };

  const sessionRes = await fetch(`${RELAY_HTTP}/auth/session`, {
    method: 'POST',
    headers: svc,
    body: JSON.stringify(DEV_IDENTITY),
  });
  const { user_id: userId } = (await sessionRes.json()) as { user_id: string };

  const codeRes = await fetch(`${RELAY_HTTP}/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e-fake' }),
  });
  const { device_code, user_code } = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
  };

  await fetch(`${RELAY_HTTP}/device/approve`, {
    method: 'POST',
    headers: svc,
    body: JSON.stringify({ user_code, user_id: userId }),
  });

  const tokenRes = await fetch(`${RELAY_HTTP}/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code }),
  });
  const poll = (await tokenRes.json()) as {
    status: string;
    device_token?: string;
    device_id?: string;
  };
  if (poll.status !== 'approved' || !poll.device_token || !poll.device_id) {
    throw new Error(`device pairing failed: ${JSON.stringify(poll)}`);
  }
  return { userId, deviceId: poll.device_id, deviceToken: poll.device_token };
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

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the session e2e (load .env or set it)');
  }

  const { userId, deviceId, deviceToken } = await pairDevice(serviceSecret);

  daemon = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(REPO_ROOT, 'apps/web/tests/e2e/fake-daemon.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RELAY_WS_URL: RELAY_WS,
        FAKE_USER_ID: userId,
        FAKE_DEVICE_ID: deviceId,
        FAKE_DEVICE_TOKEN: deviceToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await waitForReady(daemon);
});

test.afterAll(() => {
  daemon?.kill();
});

async function signInAndLaunch(
  page: import('@playwright/test').Page,
  prompt: string,
): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  // Device is paired → the session view is shown and the browser connects to the relay.
  await expect(page.getByText('CONNECTED')).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Prompt').fill(prompt);
  await page.getByRole('button', { name: 'Launch' }).click();
}

test('launches a session, streams it, and runs the gated tool once approved', async ({ page }) => {
  await signInAndLaunch(page, 'Add a hello line to the README');

  // The agent's first message streams in, then it blocks on the Write tool awaiting a human decision.
  await expect(page.getByText('Planning the change')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();

  await page.getByRole('button', { name: 'Approve' }).click();

  // The gate resolves, the tool runs, and the session finishes.
  await expect(page.getByText('APPROVED')).toBeVisible();
  await expect(page.getByText('Finished')).toBeVisible();
  await expect(page.getByText('DONE')).toBeVisible();
});

test('sends a follow-up that resumes the session for a second turn', async ({ page }) => {
  await signInAndLaunch(page, 'Add a hello line to the README');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();

  // With a session live, the composer steers it: a follow-up appears in the transcript and the agent
  // responds in a second turn.
  await page.getByLabel('Prompt').fill('now write a test too');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('now write a test too')).toBeVisible();
  await expect(page.getByText('Following up as requested')).toBeVisible();
});

test('rejects the gated tool and the session finishes without running it', async ({ page }) => {
  await signInAndLaunch(page, 'Try to overwrite a file');

  await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
  await page.getByRole('button', { name: 'Reject' }).click();

  await expect(page.getByText('REJECTED')).toBeVisible();
  await expect(page.getByText('Finished')).toBeVisible();
  await expect(page.getByText('DONE')).toBeVisible();
  // The Write tool never ran — no executed tool-call entry appears in the transcript.
  await expect(page.getByText('TOOL', { exact: true })).toHaveCount(0);
});
