import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * Board housekeeping through the real stack: delete a session straight from its board card (trash →
 * one confirm → gone), and dismiss a needs-you card without answering — the ask stays pending, the
 * session row carries the amber "waiting" chip, the header counts the hidden card honestly, the
 * dismissal survives a reload, and resolving the ask clears everything. Real relay, real Postgres,
 * real browser; the fake daemon plays the laptop.
 */
let daemon: ChildProcess | undefined;

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the board-housekeeping e2e (load .env)');
  }
  const { userId, deviceId, deviceToken } = await pairDevice(serviceSecret, 'e2e-board-house');
  daemon = await spawnFakeDaemon({ userId, deviceId, deviceToken });
});

test.afterAll(() => {
  daemon?.kill();
});

type Page = import('@playwright/test').Page;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });
}

test('deletes an ended session straight from its board card (trash → confirm → gone)', async ({
  page,
}) => {
  const TITLE = `Board delete ${Date.now()}`;
  await signIn(page);
  // Launch and finish a session (approve its one gate) so its row is deletable.
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(TITLE);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();

  await page.goto('/');
  const row = page.getByRole('listitem').filter({ hasText: TITLE }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // Only ENDED rows offer the trash (the awaiting-row absence is asserted in the dismiss test).
  const trash = row.getByRole('button', { name: `Delete session “${TITLE}”` });
  await expect(trash).toBeVisible();

  // Cancel first — nothing happens; the row survives.
  await trash.click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this session?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Files and code on your machine are not touched');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toBeVisible();

  // Confirm for real — the row is gone from the board and the archived view.
  await trash.click();
  await dialog.getByRole('button', { name: 'Delete session' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('main').getByRole('link', { name: new RegExp(TITLE) })).toHaveCount(
    0,
  );
  await page.goto('/archived');
  await expect(page.getByRole('listitem').filter({ hasText: TITLE })).toHaveCount(0);
});

test('dismissing a needs-you card moves the signal to the row chip, survives reload, clears on resolve', async ({
  page,
}) => {
  const PROMPT = `offer a handover ${Date.now()}`;
  await signIn(page);
  // Spawn the offering adopted parents (two READY TO TAKE OVER cards: long + short question).
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(PROMPT);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

  await page.goto('/');
  const longCard = page
    .getByRole('article', { name: 'READY TO TAKE OVER' })
    .filter({ hasText: 'Restyle done' })
    .first();
  await expect(longCard).toBeVisible({ timeout: 10_000 });

  // Dismiss it: the card leaves the inbox, the header says so, and the session's ROW carries the
  // amber chip — the "something is waiting" signal never silently disappears.
  await longCard.getByRole('button', { name: /Dismiss this card/ }).click();
  await expect(longCard).not.toBeVisible();
  await expect(page.getByRole('main').getByText('1 dismissed')).toBeVisible();
  const offeringRow = page
    .getByRole('listitem')
    .filter({ hasText: `offering: ${PROMPT}` })
    .first();
  await expect(offeringRow).toBeVisible();
  await expect(offeringRow.getByRole('status')).toHaveAccessibleName(/1 dismissed ask is still/);
  await expect(offeringRow.getByText('1 waiting')).toBeVisible();
  // An AWAITING row never offers the trash — the delete-offer gating, asserted explicitly.
  await expect(offeringRow.getByRole('button', { name: /Delete session/ })).toHaveCount(0);

  // A reload keeps the dismissal (localStorage) — card hidden, chip standing.
  await page.reload();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole('article', { name: 'READY TO TAKE OVER' }).filter({ hasText: 'Restyle done' }),
  ).toHaveCount(0);
  await expect(page.getByRole('main').getByText('1 dismissed')).toBeVisible();
  await expect(offeringRow.getByText('1 waiting')).toBeVisible({ timeout: 10_000 });

  // Resolve the ask (take the session over) — the chip and the honesty note both clear.
  await offeringRow.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
  await page
    .getByLabel("Your answer to the agent's free-form question")
    .fill('proceed with the map restyle');
  await page.getByRole('button', { name: 'Take over & continue' }).click();
  await expect(page.getByText('Taken over · continued in a new session')).toBeVisible({
    timeout: 10_000,
  });

  await page.goto('/');
  await expect(page.getByText('1 dismissed')).toHaveCount(0);
  await expect(page.getByText('1 waiting')).toHaveCount(0);
});

test('a failed delete keeps the dialog open and says why (error path)', async ({ page }) => {
  const TITLE = `Board delete error ${Date.now()}`;
  await signIn(page);
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(TITLE);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();

  await page.goto('/');
  // Force the BFF delete to fail — the dialog must stay open with an honest, announced reason.
  await page.route('**/api/sessions/**', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, body: 'boom' })
      : route.fallback(),
  );
  await page.getByRole('button', { name: `Delete session “${TITLE}”` }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this session?' });
  await dialog.getByRole('button', { name: 'Delete session' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/could not delete/i);
  await expect(dialog).toBeVisible();
  // The row survived the failed delete.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('main').getByRole('link', { name: new RegExp(TITLE) })).toBeVisible();
});
