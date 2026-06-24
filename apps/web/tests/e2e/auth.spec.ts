import { expect, test } from '@playwright/test';

/**
 * Phase 1 auth flow through the real stack: an unauthenticated visit is redirected to sign-in; the dev
 * provider signs the user in (web → relay /auth/session → session cookie); the authenticated landing
 * obtains a channel token and connects to the relay's WS (relay verifies the channel token); sign-out
 * revokes the session.
 */
test('dev sign-in reaches an authenticated, relay-connected landing', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByRole('button', { name: 'Continue as developer' }).click();

  // Authenticated landing (no longer on /signin), showing the signed-in user.
  await expect(page).not.toHaveURL(/\/signin$/);
  await expect(page.getByText('Developer')).toBeVisible();

  // The browser minted a channel token and authenticated its relay WS connection.
  await expect(page.getByText('CONNECTED')).toBeVisible({ timeout: 10_000 });
});

test('sign out returns to the sign-in screen', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Developer')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
