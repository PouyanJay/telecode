import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';

/**
 * The revoke → re-authorize device lifecycle (UX Phase 4) through the real stack: pair a device via
 * the relay's device-grant endpoints, revoke it from the Devices page (confirmation dialog with real
 * consequence copy), watch it move to the Revoked section, re-pair it with its prior token as restore
 * evidence (the "awaiting re-authorization" state), then complete the restore on the activate page and
 * confirm the SAME device identity returns with its history intact. Real relay, real Postgres, real
 * browser; this spec plays the daemon's HTTP half itself (no streaming, so no fake-daemon process).
 */
const RELAY_HTTP = process.env.RELAY_HTTP_URL ?? 'http://127.0.0.1:8080';
const DEV_IDENTITY = {
  provider: 'dev',
  providerUserId: 'dev-user',
  displayName: 'Developer',
  email: 'dev@telecode.local',
};

interface PairedDevice {
  userId: string;
  deviceId: string;
  deviceToken: string;
  userCode: string;
}

/** Run the device-grant flow; when `priorDeviceToken` is passed the relay may restore the same row. */
async function pairDevice(
  serviceSecret: string,
  name: string,
  priorDeviceToken?: string,
): Promise<PairedDevice> {
  const svc = { 'content-type': 'application/json', 'x-telecode-service-secret': serviceSecret };

  const sessionRes = await fetch(`${RELAY_HTTP}/auth/session`, {
    method: 'POST',
    headers: svc,
    body: JSON.stringify(DEV_IDENTITY),
  });
  const { user_id: userId } = (await sessionRes.json()) as { user_id: string };

  const codeRes = await fetch(`${RELAY_HTTP}/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      ...(priorDeviceToken ? { prior_device_token: priorDeviceToken } : {}),
    }),
  });
  const { device_code, user_code } = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
  };

  await fetch(`${RELAY_HTTP}/device/approve`, {
    method: 'POST',
    headers: svc,
    body: JSON.stringify({ user_code, user_id: userId }),
  });

  const tokenRes = await fetch(`${RELAY_HTTP}/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code }),
  });
  const poll = (await tokenRes.json()) as {
    status: string;
    device_token?: string;
    device_id?: string;
  };
  if (poll.status !== 'approved' || !poll.device_token || !poll.device_id) {
    throw new Error(`device pairing failed: ${JSON.stringify(poll)}`);
  }
  return { userId, deviceId: poll.device_id, deviceToken: poll.device_token, userCode: user_code };
}

/** Request a restore code (prior token as evidence) WITHOUT approving it — leaves it pending. */
async function requestRestoreCode(name: string, priorDeviceToken: string): Promise<void> {
  await fetch(`${RELAY_HTTP}/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, prior_device_token: priorDeviceToken }),
  });
}

type Page = import('@playwright/test').Page;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Navigate to /devices and wait until the client has hydrated (the banner is a client-only signal),
 *  so clicks land on live handlers rather than the pre-hydration SSR markup. */
async function gotoDevices(page: Page): Promise<void> {
  await page.goto('/devices');
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });
}

test.beforeAll(() => {
  loadRepoEnv();
});

test('revoke a device, then re-authorize it back to the same identity with its history', async ({
  page,
}) => {
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the devices e2e (load .env or set it)');
  }
  const deviceName = `revoke-e2e-${Date.now()}`;
  const paired = await pairDevice(serviceSecret, deviceName);

  await signIn(page);
  await gotoDevices(page);
  // Scope to the page body — the sidebar device rail lists the same names.
  const main = page.getByRole('main');

  // The device is in the active list.
  const activeRow = main.getByRole('listitem').filter({ hasText: deviceName });
  await expect(activeRow).toBeVisible();

  // Revoke opens a confirmation dialog with real consequence copy, then moves the device to Revoked.
  await activeRow.getByRole('button', { name: `Revoke ${deviceName}` }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('re-authorize');
  await expect(dialog).toContainText('no active sessions');
  await dialog.getByRole('button', { name: 'Revoke device' }).click();

  // It leaves the active list and appears in the Revoked section with a REVOKED pill + history count.
  await expect(main.getByRole('heading', { name: 'Revoked' })).toBeVisible();
  const revokedRow = main.getByRole('listitem').filter({ hasText: deviceName });
  await expect(revokedRow).toContainText('REVOKED');
  await expect(revokedRow).toContainText('in history');

  // The daemon on that machine re-pairs, presenting its prior token → awaiting re-authorization.
  await requestRestoreCode(deviceName, paired.deviceToken);
  await page.reload();
  await expect(
    main.getByRole('listitem').filter({ hasText: deviceName }).getByText('AWAITING RE-AUTH'),
  ).toBeVisible();

  // Complete the restore by approving a fresh code from the daemon (same prior token) on /activate.
  const restore = await pairDevice(serviceSecret, deviceName, paired.deviceToken);
  expect(restore.deviceId).toBe(paired.deviceId); // SAME identity restored

  await gotoDevices(page);
  // Back in the active list, gone from Revoked (this run's device name is unique to this test).
  const restoredRow = main.getByRole('listitem').filter({ hasText: deviceName });
  await expect(restoredRow).toContainText(paired.deviceId.slice(0, 18));
  await expect(restoredRow.getByText('AWAITING RE-AUTH')).toBeHidden();
});

test('the activate page confirms a restore preserved the device history', async ({ page }) => {
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the devices e2e (load .env or set it)');
  }
  const deviceName = `activate-e2e-${Date.now()}`;
  const paired = await pairDevice(serviceSecret, deviceName);

  await signIn(page);
  // Revoke via the relay directly (owner-scoped by the session token), then re-pair the daemon half
  // and enter the code on /activate.
  const del = await fetch(`${RELAY_HTTP}/me/devices/${paired.deviceId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${await sessionToken(page)}` },
  });
  if (!del.ok) throw new Error(`revoke setup failed: ${del.status}`);

  // Daemon requests a restore code (unapproved) — the code the user will type.
  const codeRes = await fetch(`${RELAY_HTTP}/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: deviceName, prior_device_token: paired.deviceToken }),
  });
  const { user_code } = (await codeRes.json()) as { user_code: string };

  await page.goto('/activate');
  await page.getByLabel('Pairing code').fill(user_code);
  await page.getByRole('button', { name: 'Activate device' }).click();

  await expect(page.getByRole('status')).toContainText('re-authorized');
  await expect(page.getByRole('status')).toContainText('history is preserved');
});

/** Read the app's session token from its cookie so the test can call owner-scoped relay routes. */
async function sessionToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const token = cookies.find((c) => c.name === 'telecode_session')?.value;
  if (!token) throw new Error('no session cookie — sign-in did not complete');
  return token;
}
