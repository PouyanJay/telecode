import { expect, test } from '@playwright/test';

/**
 * Device activation through the real stack: a (stand-in) daemon requests a pairing code from the relay;
 * a signed-in user enters that code on /activate; the web approves it server-derived (its user id is
 * never client-supplied) and the device is bound to the account.
 */
test('a signed-in user activates a device with its pairing code', async ({ page, request }) => {
  // Stand in for a daemon requesting a pairing code.
  const codeRes = await request.post('http://127.0.0.1:8080/device/code', {
    data: { name: 'e2e-laptop' },
  });
  const { user_code } = (await codeRes.json()) as { user_code: string };

  // Sign in with the dev provider.
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByRole('heading', { name: 'No sessions yet' })).toBeVisible();

  // Activate the device.
  await page.getByRole('link', { name: 'Activate a device' }).click();
  await expect(page).toHaveURL(/\/activate$/);
  await page.getByLabel('Pairing code').fill(user_code);
  await page.getByRole('button', { name: 'Activate device' }).click();

  await expect(page.getByText('Device activated')).toBeVisible();
});
