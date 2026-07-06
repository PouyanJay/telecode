import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import {
  devSessionToken,
  pairDevice,
  revokeAllDevices,
  revokeDevice,
  type PairedDevice,
} from './pairing';

/**
 * Multi-device for real (ux Phase 5) — the walking skeleton through the whole stack: TWO paired
 * devices, TWO fake daemons, one browser. The second device's daemon announces an adopted session
 * and gates it on an approval; the dashboard must surface that approval and resolve it through the
 * second device's OWN channel. Before this phase the app held a single channel to `devices[0]`, so
 * this exact flow was impossible: the other device's approvals never arrived.
 *
 * Pairing order matters for honesty: the announcing device is paired FIRST so it is NOT
 * `devices[0]` (the device list is newest-first) — a single-channel app fails this spec.
 */
// Unique per run: earlier runs of this spec leave finished sessions with the same title in the
// registry, and an ambiguous locator (or a stale awaiting twin after a failed run) must never
// decide this test.
const APPROVAL_TITLE = `Refactor the auth flow ${Date.now()}`;

let deviceMini: PairedDevice; // paired first → not devices[0]; runs the announcing daemon
let deviceMac: PairedDevice; // paired second → devices[0]; runs a silent daemon
let daemons: ChildProcess[] = [];

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the multi-device e2e (load .env)');
  }

  // Hermetic fleet: earlier spec files (and earlier local runs) accumulate paired devices, each of
  // which would get a live channel. Start from zero so this spec's TWO devices are the fleet.
  await revokeAllDevices(await devSessionToken(serviceSecret));

  deviceMini = await pairDevice(serviceSecret, 'e2e-mini');
  deviceMac = await pairDevice(serviceSecret, 'e2e-mac');

  daemons = await Promise.all([
    spawnFakeDaemon({ ...deviceMini, adoptAnnounce: APPROVAL_TITLE }),
    spawnFakeDaemon({ ...deviceMac }),
  ]);
});

test.afterAll(async () => {
  for (const daemon of daemons) daemon.kill();
  // Revoke this spec's devices so later spec files inherit no live leftovers (the revoke cascade
  // also retires any session this spec left non-terminal).
  if (deviceMini) await revokeDevice(deviceMini.sessionToken, deviceMini.deviceId);
  if (deviceMac) await revokeDevice(deviceMac.sessionToken, deviceMac.deviceId);
});

type Page = import('@playwright/test').Page;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });
}

test('both devices show honest per-device presence (REST snapshot + live channels)', async ({
  page,
}) => {
  await signIn(page);

  // Every paired device row reports ITS OWN presence — before this phase only devices[0] could
  // ever read online, whatever the rest of the fleet was doing.
  const deviceList = page.getByRole('list', { name: 'Paired devices' });
  await expect(deviceList.getByRole('listitem').filter({ hasText: 'e2e-mac' })).toContainText(
    'online',
    { timeout: 10_000 },
  );
  await expect(deviceList.getByRole('listitem').filter({ hasText: 'e2e-mini' })).toContainText(
    'online',
    { timeout: 10_000 },
  );
});

test('the launch drawer picks a device: a launch lands on the CHOSEN machine, not devices[0]', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Launch session' })).toBeVisible();

  // Pick the SECOND device (not devices[0]) and launch on it.
  await page.getByLabel('Run on').selectOption(deviceMini.deviceId);
  await page.getByLabel('First instruction').fill('Run on the mini please');
  await page.getByRole('button', { name: 'Launch on e2e-mini' }).click();

  // The mini's fake daemon received the launch and streams: its first message, then its gate.
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await expect(page.getByText('Planning the change')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  // The session view attributes the session to the device it actually runs on.
  await expect(page.getByLabel('Session details')).toContainText('e2e-mini');

  // Finish it so no pending gate leaks into the next test's inbox assertions.
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();
});

test('an approval raised on a second device arrives and resolves through its own channel', async ({
  page,
}) => {
  await signIn(page);

  // The /devices row deep-links the board scoped to that device (plan B4) …
  await page.goto('/devices');
  const miniRow = page.getByRole('listitem').filter({ hasText: 'e2e-mini' });
  await expect(miniRow.getByRole('link', { name: /needs you →/ })).toBeVisible({
    timeout: 15_000,
  });
  await miniRow.getByRole('link', { name: /needs you →/ }).click();
  await expect(page).toHaveURL(new RegExp(`\\?device=${deviceMini.deviceId}`));

  // … where the device's chip is the active scope.
  const chips = page.getByRole('navigation', { name: 'Filter sessions by device' });
  await expect(chips.getByRole('link', { name: /e2e-mini/ })).toHaveAttribute(
    'aria-current',
    'true',
  );

  // The second device's pending approval surfaces in the needs-you inbox: the dashboard
  // auto-subscribes the awaiting registry row, routed to the session's OWN device's channel, and
  // that daemon backfills the pending gate.
  const card = page
    .getByRole('article', { name: 'APPROVAL NEEDED' })
    .filter({ hasText: APPROVAL_TITLE });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Approving routes the decision out on the second device's channel; its daemon runs the tool and
  // finishes the session — the ask resolves without a reload.
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0, { timeout: 10_000 });

  // The resolved conversation settles into the list as a finished row.
  const row = page.getByRole('main').getByRole('link', { name: new RegExp(APPROVAL_TITLE) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('COMPLETED');
});

test('one daemon dropping flips only ITS device offline — the other stays online', async ({
  page,
}) => {
  await signIn(page);
  const deviceList = page.getByRole('list', { name: 'Paired devices' });
  await expect(deviceList.getByRole('listitem').filter({ hasText: 'e2e-mac' })).toContainText(
    'online',
    { timeout: 10_000 },
  );

  // The mac's daemon dies (kill, not clean shutdown — like a crashed laptop process).
  daemons[1]?.kill();

  // Its row flips offline via the live presence frame; the mini's row must not move.
  await expect(deviceList.getByRole('listitem').filter({ hasText: 'e2e-mac' })).not.toContainText(
    'online',
    { timeout: 10_000 },
  );
  await expect(deviceList.getByRole('listitem').filter({ hasText: 'e2e-mini' })).toContainText(
    'online',
  );
});

// LAST on purpose: it revokes e2e-mini, which every earlier test still needs in the fleet.
test('a revoked device’s session says DEVICE REVOKED — never an infinite spinner', async ({
  page,
}) => {
  await signIn(page);

  // Put a real finished session on the mini, and remember its view URL.
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('Run on').selectOption(deviceMini.deviceId);
  await page.getByLabel('First instruction').fill('Session on a doomed device');
  await page.getByRole('button', { name: 'Launch on e2e-mini' }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();
  const sessionUrl = page.url();

  // Revoke the mini, then cold-load the session view: no channel exists for a revoked device, so
  // nothing can backfill — the view must SAY that instead of spinning forever (ux Phase 5 T7).
  await revokeDevice(deviceMini.sessionToken, deviceMini.deviceId);
  await page.goto(sessionUrl);
  await expect(page.getByText('DEVICE REVOKED')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/has been revoked/)).toBeVisible();
});
