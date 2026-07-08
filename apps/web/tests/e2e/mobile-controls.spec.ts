import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * Honest, everywhere-visible session controls (adopted-takeover T6+T7): the header controls exist on
 * a phone (they used to be display:none under 640px — no way to Interrupt or End at all), and they
 * are honest per origin — an adopted session offers "Stop following" (never Interrupt: there is no
 * telecode-owned turn to abort), a launched one keeps Interrupt/End. Real stack; phone-sized viewport.
 */
let daemon: ChildProcess | undefined;

test.use({ viewport: { width: 390, height: 844 } });

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the mobile-controls e2e (load .env)');
  }
  const { userId, deviceId, deviceToken } = await pairDevice(serviceSecret, 'e2e-mobile');
  daemon = await spawnFakeDaemon({ userId, deviceId, deviceToken });
});

test.afterAll(() => {
  daemon?.kill();
});

test('a phone shows Interrupt/End on a launched session mid-gate', async ({ page }) => {
  const PROMPT = `gate for mobile controls ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });

  // Launch: the fake daemon parks the session on a Write gate (awaiting_input → busy).
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(PROMPT);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

  // The controls are VISIBLE and operable at phone width — no display:none.
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'End', exact: true })).toBeVisible();
});

test('a phone shows the honest "Stop following" (and never Interrupt) on an adopted session', async ({
  page,
}) => {
  const PROMPT = `park at the terminal ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(PROMPT);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

  await page.goto('/');
  const row = page.getByRole('main').getByRole('link', { name: new RegExp(`adopted: ${PROMPT}`) });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  const stopFollowing = page.getByRole('button', { name: 'Stop following' });
  await expect(stopFollowing).toBeVisible({ timeout: 10_000 });
  await expect(stopFollowing).toHaveAttribute('title', /local process is untouched/);
  await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);

  // Stop following retires the mirror — the honest ending, on the phone, in one tap. The rail is
  // collapsed at phone width, so assert the user-visible consequences: the ended session's composer
  // flips to Resume-as-new and the follow controls leave the header.
  await stopFollowing.click();
  await expect(page.getByRole('button', { name: 'Resume as new' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('button', { name: 'Stop following' })).toHaveCount(0);
});
