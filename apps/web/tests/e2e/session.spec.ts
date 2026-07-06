import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * The Phase 1 core loop through the real stack (plan §5 exit criteria): from the web app, launch a
 * session on a paired device, watch the agent stream, and approve/reject its actions. A deterministic
 * fake daemon (see fake-daemon.ts) stands in for the laptop — everything else is real: real relay, real
 * Postgres, real browser. The device is paired via the relay's actual device-grant endpoints so the
 * browser connects on the daemon's `(user_id, device_id)` channel, exactly as in production.
 */
let daemon: ChildProcess | undefined;

// Unique per run: chain threads persist in the registry across local runs, and the thread-collapse
// assertion below ("exactly one row") must only ever see THIS run's chain.
const CHAIN_TITLE = `Fix the pairing bug ${Date.now()}`;

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the session e2e (load .env or set it)');
  }

  const { userId, deviceId, deviceToken } = await pairDevice(serviceSecret, 'e2e-fake');
  daemon = await spawnFakeDaemon({ userId, deviceId, deviceToken, chainTitle: CHAIN_TITLE });
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
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();
});

test('the launched session appears in the dashboard list with live status', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'Add a hello line to the README');
  // It backfilled on the session view, so its prompt becomes the list title; the gate is still pending.
  await expect(page.getByText('Planning the change')).toBeVisible();

  await page.getByRole('link', { name: 'Back to sessions' }).click();
  await expect(page).toHaveURL(/\/$/);

  // An awaiting session surfaces at the top of the dashboard as a needs-you inbox card (approval
  // reliability T6): named ask, the session title linking in, and the inline decision actions.
  const card = page.getByRole('article', { name: 'APPROVAL NEEDED' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: /Add a hello line to the README/ })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
});

test('reopen = reconnect: the transcript restores after a reload (daemon backfill)', async ({
  page,
}) => {
  // Unique per run: the title assertion below must match exactly ONE dashboard row, and identical
  // prompts accumulate across local runs (same pattern as CHAIN_TITLE).
  const REOPEN_PROMPT = `Reopen the README change ${Date.now()}`;
  await signIn(page);
  await launchFromDashboard(page, REOPEN_PROMPT);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();

  // Reload the session view: the in-memory store is cleared, so the daemon must backfill the transcript
  // via session.subscribe → session.history (reopen is a reconnect, never a restart).
  await page.reload();
  await expect(page.getByText('Planning the change')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Finished')).toBeVisible();
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();
  // The previously-approved gate replays as decided, not as a fresh actionable prompt.
  await expect(page.getByText('APPROVED')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  // Session identity survives the reload (ux Phase 6): the session view's header names the session
  // from its metadata, and the dashboard row does the same from the persisted `session.meta` blob —
  // a launched row used to degrade to its raw session UUID on both surfaces.
  await expect(page.getByRole('heading', { name: REOPEN_PROMPT })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: REOPEN_PROMPT })).toBeVisible();
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

test('a turn-limited run reads as ENDED · TURN LIMIT and continues from the composer', async ({
  page,
}) => {
  await signIn(page);
  // The magic prefix makes the fake daemon end the run on its turn budget (status split, ux Phase 6 T2).
  await launchFromDashboard(page, `hit the turn limit ${Date.now()}`);

  await expect(page.getByText('Ran out of turns mid-task')).toBeVisible();
  await expect(page.getByLabel('Session details').getByText('ENDED · TURN LIMIT')).toBeVisible();
  // The honest affordance: this ending is a pause, not a death — the composer continues the run.
  await expect(page.getByText(/Turn limit reached/)).toBeVisible();
  await page.getByLabel('Prompt').fill('please continue');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Following up as requested')).toBeVisible();
});

test('rejects the gated tool and the session finishes without running it', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'Try to overwrite a file');

  // `exact` — "Reject with note…" (deny-with-note, approval reliability T5) also matches otherwise.
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();

  await expect(page.getByText('REJECTED')).toBeVisible();
  await expect(page.getByText('Finished')).toBeVisible();
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();
  // The Write tool never ran — no executed tool-call entry appears in the transcript.
  await expect(page.getByText('TOOL', { exact: true })).toHaveCount(0);
});

test('interrupt stops a running turn and the session ends (done)', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'a long task');
  // The turn is in flight (gated, awaiting input), so the Interrupt control is offered.
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Interrupt' }).click();
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();
});

test('interrupt stops the turn and the session stays followable', async ({ page }) => {
  await signIn(page);
  await launchFromDashboard(page, 'a task to interrupt');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();

  // Interrupt aborts the in-flight turn (like Esc); the session ends the turn but stays open.
  await page.getByRole('button', { name: 'Interrupt' }).click();
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();
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

test('a taken-over conversation reads as ONE thread: crumb, lineage strip, takeover divider', async ({
  page,
}) => {
  await signIn(page);
  // The magic prompt makes the fake daemon mint an adopted "terminal" parent + a chained telecode
  // continuation through the real relay/registry (see fake-daemon.ts).
  await launchFromDashboard(page, 'chain a takeover');
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();

  // Cold-load the dashboard until the registry serves the chain (the dance settles asynchronously).
  const threadRow = () =>
    page.getByRole('main').getByRole('link', { name: new RegExp(CHAIN_TITLE) });
  await expect(async () => {
    await page.goto('/');
    await expect(threadRow()).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // ONE collapsed row for the conversation — the parent has no row of its own — carrying the segment
  // crumb: origin and the hop, with times.
  await expect(threadRow()).toContainText('terminal');
  await expect(threadRow()).toContainText('taken over');

  // The row opens the LEAF (the live continuation), which tells the whole story:
  await threadRow().click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
  const strip = page.getByRole('navigation', { name: 'Conversation lineage' });
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('SEGMENT 1 · terminal');
  await expect(strip).toContainText('SEGMENT 2 · telecode');

  // The inherited terminal transcript is inlined COLLAPSED above the takeover divider.
  const disclosure = page.getByText(/earlier entries from the terminal segment/);
  await expect(disclosure).toBeVisible();
  await expect(page.getByText('Found the race in the token poll')).not.toBeVisible();
  await disclosure.click();
  await expect(page.getByText('Found the race in the token poll')).toBeVisible();
  await expect(page.getByText(/Taken over in telecode/)).toBeVisible();

  // Jumping to segment 1 (the superseded parent) shows the forward pointer instead of a dead end…
  await strip.getByRole('link', { name: /SEGMENT 1/ }).click();
  const forward = page.getByRole('link', { name: /Continued in telecode/ });
  await expect(forward).toBeVisible();
  // …and it navigates back into the continuation.
  await forward.click();
  await expect(page.getByText('Continuing in telecode')).toBeVisible();
});
