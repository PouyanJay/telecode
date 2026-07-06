import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * Resume-as-new through the real stack (ux Phase 6 T8): a session whose conversation the daemon LOST
 * (`needs_restart`) can only continue as a new linked session — the view says so, the composer flips to
 * "Resume as new", and sending routes `session.resume_new` → daemon → a `session.chained` child the
 * browser navigates into. Real relay, real Postgres, real browser; the fake daemon plays the laptop.
 */
let daemon: ChildProcess | undefined;

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the resume-new e2e (load .env)');
  }
  const { userId, deviceId, deviceToken } = await pairDevice(serviceSecret, 'e2e-resume');
  daemon = await spawnFakeDaemon({ userId, deviceId, deviceToken });
});

test.afterAll(() => {
  daemon?.kill();
});

test('a lost session continues as a NEW linked session from its composer', async ({ page }) => {
  const PROMPT = `lose this session ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });

  // Launch the doomed session: the fake daemon "loses" it (needs_restart).
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(PROMPT);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  const parentUrl = page.url();

  // The honest state + the honest way forward: needs-restart pill, standing notice, flipped composer.
  await expect(page.getByLabel('Session details').getByText('NEEDS RESTART')).toBeVisible();
  await expect(page.getByText(/can’t continue here/)).toBeVisible();
  const composerSubmit = page.getByRole('button', { name: 'Resume as new' });
  await expect(composerSubmit).toBeVisible();

  // Send the continuation prompt — the browser lands on the freshly minted CHILD session (a
  // DIFFERENT session URL; the plain regex would match the parent's too).
  await page.getByLabel('Prompt').fill('pick the work back up');
  await composerSubmit.click();
  await expect(page).not.toHaveURL(parentUrl, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);

  // The child runs the prompt as its first turn and is LINKED to the lost parent (lineage strip).
  await expect(page.getByText('Picking up where we left off')).toBeVisible({ timeout: 10_000 });
  const strip = page.getByRole('navigation', { name: 'Conversation lineage' });
  await expect(strip).toBeVisible({ timeout: 10_000 });
  await expect(strip).toContainText('SEGMENT 2');

  // Outcome chips (mockup §01-7). The resumed thread above collapsed into its COMPLETED leaf, so
  // mint a SECOND lost session and leave it unresumed — the board then deterministically holds 2+
  // endings (COMPLETED + NEEDS RESTART) even on a fresh CI database. Order-tolerant asserts only
  // (accumulated local sessions vary the counts).
  const DOOMED = `lose this session again ${Date.now()}`;
  await page.goto('/');
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Launch session' })).toBeVisible();
  await page.getByLabel('First instruction').fill(DOOMED);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await expect(page.getByLabel('Session details').getByText('NEEDS RESTART')).toBeVisible();

  await page.goto('/');
  const chips = page.getByRole('navigation', { name: 'Filter ended sessions by outcome' });
  await expect(chips).toBeVisible({ timeout: 10_000 });
  await chips.getByRole('link', { name: /NEEDS RESTART/ }).click();
  await expect(page).toHaveURL(/\?outcome=needs_restart/);
  await expect(chips.getByRole('link', { name: /NEEDS RESTART/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  // The scope keeps the doomed session and hides the completed thread from earlier in this test.
  await expect(
    page.getByRole('main').getByRole('link', { name: new RegExp(DOOMED) }),
  ).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('link', { name: /pick the work back up/ }),
  ).toHaveCount(0);
});
