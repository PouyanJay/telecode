import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';
import { encodeKey, generateKeyPair } from '@telecode/protocol';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * Session rename through the real stack on a REAL E2E channel (deferred from T6b — rename is
 * E2E-gated, so this spec runs the fake daemon in its opt-in encrypted mode): the browser seals the
 * launch, unwraps the delivered content key, seals the rename override, and — after a full reload —
 * decrypts it back from the persisted `sealed_title` blob with its IndexedDB-persisted key. Also
 * proves override-wins (the derived title never clobbers the rename) and reset-to-derived.
 */
let daemon: ChildProcess | undefined;

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the rename e2e (load .env)');
  }
  const keyPair = await generateKeyPair();
  const publicKey = encodeKey(keyPair.publicKey);
  const paired = await pairDevice(serviceSecret, 'e2e-rename', { publicKey });
  daemon = await spawnFakeDaemon({
    userId: paired.userId,
    deviceId: paired.deviceId,
    deviceToken: paired.deviceToken,
    privateKey: encodeKey(keyPair.privateKey),
  });
});

test.afterAll(() => {
  daemon?.kill();
});

test('rename an E2E session; the sealed override survives a reload and resets to derived', async ({
  page,
}) => {
  const PROMPT = `Rename me later ${Date.now()}`;
  const NEW_NAME = `My deploy run ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });

  // Launch on the ENCRYPTED device (the drawer picks it when it's the only online one) and finish.
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(PROMPT);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();

  // Rename via the header editor — only possible because the browser holds the content key (E2E).
  await page.getByRole('button', { name: 'Rename session' }).click();
  await page.getByLabel('Session name').fill(NEW_NAME);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: NEW_NAME })).toBeVisible({ timeout: 10_000 });

  // The override survives a full reload: decrypted from the persisted sealed_title blob with the
  // browser's IndexedDB-persisted content key — and it beats the derived title (override-wins).
  await page.reload();
  await expect(page.getByRole('heading', { name: NEW_NAME })).toBeVisible({ timeout: 10_000 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(NEW_NAME) })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('link', { name: new RegExp(PROMPT) })).toHaveCount(0);

  // Reset-to-derived: the prompt-derived title comes back.
  await page.getByRole('link', { name: new RegExp(NEW_NAME) }).click();
  await page.getByRole('button', { name: 'Rename session' }).click();
  await page.getByRole('button', { name: 'Reset to default name' }).click();
  await expect(page.getByRole('heading', { name: PROMPT })).toBeVisible({ timeout: 10_000 });
});
