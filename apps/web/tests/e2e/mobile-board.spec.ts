import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * Board housekeeping on a phone (board-housekeeping, mobile pass): the row trash and the card
 * dismiss must be visible and tappable at 390×844 — never hover-gated or clipped.
 */
let daemon: ChildProcess | undefined;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the mobile-board e2e (load .env)');
  }
  const { userId, deviceId, deviceToken } = await pairDevice(serviceSecret, 'e2e-mobile-board');
  daemon = await spawnFakeDaemon({ userId, deviceId, deviceToken });
});

test.afterAll(() => {
  daemon?.kill();
});

test('a phone can delete from the card and dismiss a needs-you card', async ({ page }) => {
  const PROMPT = `offer a handover ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });

  // Spawn the offering adopted parents; the TRIGGER session itself ends (deletable row).
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(PROMPT);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

  await page.goto('/');
  // Dismiss works by touch: card gone, chip standing on the offering session's row.
  const longCard = page
    .getByRole('article', { name: 'READY TO TAKE OVER' })
    .filter({ hasText: 'Restyle done' })
    .first();
  await expect(longCard).toBeVisible({ timeout: 10_000 });
  await longCard.getByRole('button', { name: /Dismiss this card/ }).tap();
  await expect(longCard).not.toBeVisible();
  const offeringRow = page
    .getByRole('listitem')
    .filter({ hasText: `offering: ${PROMPT}` })
    .first();
  await expect(offeringRow.getByText('1 waiting')).toBeVisible();

  // The ended TRIGGER session is the only deletable row (awaiting rows offer none — asserted in
  // board-housekeeping.spec) — its trash is visible and tappable; confirming removes exactly it.
  const trash = page.getByRole('button', { name: new RegExp(`Delete session .${PROMPT}.`) });
  await expect(trash).toBeVisible();
  const triggerHref = await page
    .getByRole('link', { name: new RegExp(PROMPT) })
    .filter({ hasText: 'COMPLETED' })
    .first()
    .getAttribute('href');
  await trash.tap();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this session?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete session' }).tap();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`a[href="${triggerHref}"]`)).toHaveCount(0);
  await expect(trash).toHaveCount(0);
});
