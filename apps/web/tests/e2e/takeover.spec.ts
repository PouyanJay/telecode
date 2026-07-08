import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * One-step takeover through the real stack (adopted-takeover T4): an ADOPTED session parked between
 * turns reads AT YOUR TERMINAL, its composer is LIVE with a standing note explaining what Send does,
 * and sending routes `session.resume_new` → daemon → a `session.chained` child the browser navigates
 * into — while the parent mirror retires to COMPLETED. Real relay, real Postgres, real browser; the
 * fake daemon plays the laptop (its "park at the terminal" magic prompt spawns the adopted parent).
 */
let daemon: ChildProcess | undefined;

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the takeover e2e (load .env)');
  }
  const { userId, deviceId, deviceToken } = await pairDevice(serviceSecret, 'e2e-takeover');
  daemon = await spawnFakeDaemon({ userId, deviceId, deviceToken });
});

test.afterAll(() => {
  daemon?.kill();
});

test('a between-turns adopted session is taken over from its composer in one step', async ({
  page,
}) => {
  const PROMPT = `park at the terminal ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });

  // The trigger session spawns the adopted parent, parked between turns.
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(PROMPT);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

  // Open the adopted parent from the board — it reads calm, honest, and ACTIVE.
  await page.goto('/');
  const row = page.getByRole('main').getByRole('link', { name: new RegExp(`adopted: ${PROMPT}`) });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
  const parentUrl = page.url();
  await expect(page.getByLabel('Session details').getByText('AT YOUR TERMINAL')).toBeVisible({
    timeout: 10_000,
  });

  // The standing note explains the one-step takeover; the composer is LIVE (no silent spinner).
  await expect(page.getByText(/This session lives in your terminal/)).toBeVisible();
  const composerSubmit = page.getByRole('button', { name: 'Send', exact: true });
  await expect(composerSubmit).toBeEnabled();

  // Send the next task — the browser lands on the freshly minted CHILD session.
  await page.getByLabel('Prompt').fill('take over and add the tests');
  await composerSubmit.click();
  await expect(page).not.toHaveURL(parentUrl, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);

  // The child carries the conversation forward, LINKED to the adopted parent (lineage strip).
  await expect(page.getByText('Picking up where we left off')).toBeVisible({ timeout: 10_000 });
  const strip = page.getByRole('navigation', { name: 'Conversation lineage' });
  await expect(strip).toBeVisible({ timeout: 10_000 });
  await expect(strip).toContainText('SEGMENT 2');

  // And the parent mirror retired: reopening it reads COMPLETED, not AT YOUR TERMINAL.
  await page.goto(parentUrl);
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible({
    timeout: 10_000,
  });
});
