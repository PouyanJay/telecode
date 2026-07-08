import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * Formatted takeover cards (adopted-takeover T8): a handover offer's question — the agent's long,
 * structured final message — renders as real markdown (headings, bold, lists) in BOTH the dashboard
 * needs-you card (clamped preview) and the in-session handover card, never as one flat paragraph of
 * raw `##`/`**` noise. Real stack; the fake daemon's "offer a handover" prompt spawns the offer.
 */
let daemon: ChildProcess | undefined;

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the handover-markdown e2e (load .env)');
  }
  const { userId, deviceId, deviceToken } = await pairDevice(serviceSecret, 'e2e-handover-md');
  daemon = await spawnFakeDaemon({ userId, deviceId, deviceToken });
});

test.afterAll(() => {
  daemon?.kill();
});

test('a markdown handover question renders formatted on the board card and in the session', async ({
  page,
}) => {
  const PROMPT = `offer a handover ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });

  // The trigger spawns the offering adopted parent (its turn ended on a markdown question).
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(PROMPT);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

  // Dashboard: the READY TO TAKE OVER card renders MARKDOWN — a real heading and bold text, and no
  // raw marker noise anywhere on the card.
  await page.goto('/');
  const card = page
    .getByRole('article', { name: 'READY TO TAKE OVER' })
    .filter({ hasText: 'Restyle done' })
    .first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(
    card.getByRole('heading', { name: 'Restyle done — one decision left' }),
  ).toBeVisible();
  await expect(card.locator('strong', { hasText: 'lesson rail' })).toBeVisible();
  await expect(card).not.toContainText('##');
  await expect(card).not.toContainText('**');

  // In the session: the handover card renders the same message as markdown, with the answer box.
  await card.getByRole('link', { name: 'Review & take over →' }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
  const gate = page.getByRole('region', { name: 'Free-form question from the agent' });
  await expect(gate).toBeVisible({ timeout: 10_000 });
  await expect(
    gate.getByRole('heading', { name: 'Restyle done — one decision left' }),
  ).toBeVisible();
  await expect(gate.getByRole('listitem').first()).toContainText('P4 and P5');
  await expect(gate).not.toContainText('##');
  await expect(gate.getByRole('button', { name: 'Take over & continue' })).toBeVisible();
});
