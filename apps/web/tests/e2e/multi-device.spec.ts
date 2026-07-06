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

test('an approval raised on a second device arrives and resolves through its own channel', async ({
  page,
}) => {
  await signIn(page);

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
  await expect(row).toContainText('DONE');
});
