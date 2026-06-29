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

type Page = import('@playwright/test').Page;

/** Sign in and wait for the dashboard's channel to connect. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });
}

/** Open the launch drawer (the sidebar action, or the empty-state CTA on a fresh dashboard). */
async function openLaunchDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Launch session' })).toBeVisible();
}

/** Launch a session from the drawer; resolves once the per-id session view is shown. */
async function launchFromDashboard(page: Page, prompt: string): Promise<void> {
  await openLaunchDrawer(page);
  await page.getByLabel('First instruction').fill(prompt);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
}

test('launch from the dashboard, stream on the session view, approve the gated tool', async ({
  page,
}) => {
  await signIn(page);
  await launchFromDashboard(page, 'Add a hello line to the README');

  // The agent's first message streams in, then it blocks on the Write tool awaiting a human decision.
  await expect(page.getByText('Planning the change')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();

  await page.getByRole('button', { name: 'Approve' }).click();

  // The gate resolves, the tool runs, and the session finishes.
  await expect(page.getByText('APPROVED')).toBeVisible();
  await expect(page.getByText('Finished')).toBeVisible();
  await expect(page.getByLabel('Session details').getByText('DONE')).toBeVisible();
});

test('the launched session appears in the dashboard list with live status', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'Add a hello line to the README');
  // It backfilled on the session view, so its prompt becomes the list title; the gate is still pending.
  await expect(page.getByText('Planning the change')).toBeVisible();

  await page.getByRole('link', { name: 'Back to sessions' }).click();
  await expect(page).toHaveURL(/\/$/);

  // This specific session is listed, showing its live awaiting-input status (sorted to the top).
  const row = page.getByRole('link', { name: /Add a hello line to the README/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('AWAITING INPUT');
});

test('reopen = reconnect: the transcript restores after a reload (daemon backfill)', async ({
  page,
}) => {
  await signIn(page);
  await launchFromDashboard(page, 'Add a hello line to the README');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();

  // Reload the session view: the in-memory store is cleared, so the daemon must backfill the transcript
  // via session.subscribe → session.history (reopen is a reconnect, never a restart).
  await page.reload();
  await expect(page.getByText('Planning the change')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Finished')).toBeVisible();
  await expect(page.getByLabel('Session details').getByText('DONE')).toBeVisible();
  // The previously-approved gate replays as decided, not as a fresh actionable prompt.
  await expect(page.getByText('APPROVED')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('sends a follow-up that resumes the session for a second turn', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'Add a hello line to the README');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();

  // The composer steers the session: the follow-up appears and the agent responds in a second turn.
  await page.getByLabel('Prompt').fill('now write a test too');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('now write a test too')).toBeVisible();
  await expect(page.getByText('Following up as requested')).toBeVisible();
});

test('rejects the gated tool and the session finishes without running it', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'Try to overwrite a file');

  await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
  await page.getByRole('button', { name: 'Reject' }).click();

  await expect(page.getByText('REJECTED')).toBeVisible();
  await expect(page.getByText('Finished')).toBeVisible();
  await expect(page.getByLabel('Session details').getByText('DONE')).toBeVisible();
  // The Write tool never ran — no executed tool-call entry appears in the transcript.
  await expect(page.getByText('TOOL', { exact: true })).toHaveCount(0);
});

test('interrupt stops a running turn and the session ends (done)', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'a long task');
  // The turn is in flight (gated, awaiting input), so the Interrupt control is offered.
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Interrupt' }).click();
  await expect(page.getByLabel('Session details').getByText('DONE')).toBeVisible();
});

test('interrupt stops the turn and the session stays followable', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'a task to interrupt');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();

  // Interrupt aborts the in-flight turn (like Esc); the session ends the turn but stays open.
  await page.getByRole('button', { name: 'Interrupt' }).click();
  await expect(page.getByLabel('Session details').getByText('DONE')).toBeVisible();
  // Continue by typing — the composer is open for a follow-up (no separate Resume needed).
  await expect(page.getByPlaceholder('Send a follow-up instruction…')).toBeEnabled();
});

// NOTE: the "Enable notifications" affordance can't be e2e'd — headless Chromium reports web push
// `unsupported` (no PushManager/Notification), and real push delivery needs a push service. The pure
// VAPID-key conversion is unit-tested (push-key.test.ts); the SW + subscribe flow are verified manually.

test('the launch drawer prompts to connect GitHub when no repo is available (dev user)', async ({
  page,
}) => {
  await signIn(page);
  // The dev user has no stored GitHub token, so the drawer's picker degrades to a connect prompt — and a
  // launch with no repo still works (it runs in the daemon's default workspace).
  await openLaunchDrawer(page);
  await expect(page.getByText(/Connect GitHub/)).toBeVisible();
  await expect(page.getByLabel('Repository')).toHaveCount(0);
  await page.getByLabel('First instruction').fill('Work without a repo');
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await expect(page.getByText('Planning the change')).toBeVisible();
});
