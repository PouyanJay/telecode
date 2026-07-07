import type { ChildProcess } from 'node:child_process';

import { expect, test } from '@playwright/test';
import { Pool } from 'pg';

import { loadRepoEnv } from './env';
import { spawnFakeDaemon } from './fake-daemon-process';
import { pairDevice } from './pairing';

/**
 * Session housekeeping through the real stack (ux Phase 6 T7): archive an ended session from its view
 * (it leaves the board), restore it from the archived view, then delete it for good behind the
 * ConfirmDialog; "Load more" pages the ended group and the archived view. Real relay, real Postgres,
 * real browser; the fake daemon stands in for the laptop. Pagination rows are seeded straight into
 * Postgres (60 launches through the UI would be absurd) and cleaned up by run id afterAll.
 */
let daemon: ChildProcess | undefined;
let db: Pool | undefined;
let userId = '';
let deviceId = '';

// Unique per run: local DBs accumulate rows across runs; every seeded title carries this.
const RUN_ID = `${Date.now()}`;
const PAGE_SIZE = 50; // the relay's DEFAULT_ENDED_PAGE_SIZE
const SEEDED = PAGE_SIZE + 10; // spills into a second page with margin for this run's own sessions

test.beforeAll(async () => {
  loadRepoEnv();
  const serviceSecret = process.env.RELAY_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('RELAY_SERVICE_SECRET is required for the housekeeping e2e (load .env)');
  }
  const paired = await pairDevice(serviceSecret, 'e2e-house');
  userId = paired.userId;
  deviceId = paired.deviceId;
  daemon = await spawnFakeDaemon({ userId, deviceId, deviceToken: paired.deviceToken });
  db = new Pool({ connectionString: process.env.DATABASE_URL });
});

test.afterAll(async () => {
  daemon?.kill();
  await db?.query('delete from sessions where title like $1', [`Paged %${RUN_ID}`]);
  await db?.end();
});

/** Seed `count` ended rows straight into the registry, newest-first from `now`, oldest last. */
async function seedEndedRows(prefix: string, count: number, archived: boolean): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await db!.query(
      `insert into sessions (user_id, device_id, title, status, updated_at, ended_at, archived_at)
       values ($1, $2, $3, 'done', now() - make_interval(secs => $4), now() - make_interval(secs => $4),
               case when $5 then now() - make_interval(secs => $4) else null end)`,
      [userId, deviceId, `${prefix} ${i} ${RUN_ID}`, i, archived],
    );
  }
}

type Page = import('@playwright/test').Page;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as developer' }).click();
  await expect(page.getByText('Relay connected')).toBeVisible({ timeout: 10_000 });
}

/** Launch a session and run it to COMPLETED (approve its one gated tool). */
async function launchToCompletion(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Launch session' })).toBeVisible();
  await page.getByLabel('First instruction').fill(prompt);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();
  await expect(page.getByLabel('Session details').getByText('COMPLETED')).toBeVisible();
}

test('archive from the session view, restore from the archived view, then delete for good', async ({
  page,
}) => {
  const TITLE = `Archive lifecycle ${Date.now()}`;
  await signIn(page);
  await launchToCompletion(page, TITLE);

  // The registry row lands with the layout data on a fresh load — housekeeping appears then (AD-14).
  await page.reload();
  await expect(page.getByRole('button', { name: 'Archive' })).toBeVisible({ timeout: 10_000 });
  // Let the daemon backfill settle before clicking — a click dispatched into a mid-backfill
  // re-render can be dropped with the replaced DOM node (the click "lands" on a dead button).
  await expect(page.getByText('Finished')).toBeVisible({ timeout: 10_000 });

  // Archive: back on the board, the row is gone from the default list — no ghost resurrects it (AD-13).
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  const boardRow = () => page.getByRole('main').getByRole('link', { name: new RegExp(TITLE) });
  await expect(boardRow()).toHaveCount(0);

  // The archived view lists it (title decrypted from its sealed blobs) with Restore + Delete.
  await page.goto('/archived');
  const archivedRow = () => page.getByRole('listitem').filter({ hasText: TITLE });
  await expect(archivedRow()).toHaveCount(1, { timeout: 10_000 });

  // Restore: it leaves the archive and returns to the board's Recent group.
  await archivedRow().getByRole('button', { name: 'Restore' }).click();
  await expect(archivedRow()).toHaveCount(0, { timeout: 10_000 });
  await page.goto('/');
  await expect(boardRow()).toHaveCount(1, { timeout: 10_000 });

  // Archive again (from the view), then DELETE from the archived view — cancel first, then confirm.
  await boardRow().click();
  await expect(page.getByRole('button', { name: 'Archive' })).toBeVisible({ timeout: 10_000 });
  // Same settle rule: the view backfills on open; click only once the transcript is in.
  await expect(page.getByText('Finished')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  await page.goto('/archived');
  await expect(archivedRow()).toHaveCount(1, { timeout: 10_000 });

  await archivedRow().getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this session?' });
  await expect(dialog).toBeVisible();
  // Cancel-by-default: backing out keeps the session.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(archivedRow()).toHaveCount(1);

  await archivedRow().getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete session' }).click();
  await expect(archivedRow()).toHaveCount(0, { timeout: 10_000 });

  // Gone for good: neither the board nor the archive lists it.
  await page.goto('/');
  await expect(boardRow()).toHaveCount(0);
  await page.goto('/archived');
  await expect(archivedRow()).toHaveCount(0);
});

test('delete straight from the session view header (confirm → board, row gone)', async ({
  page,
}) => {
  const TITLE = `View delete ${Date.now()}`;
  await signIn(page);
  await launchToCompletion(page, TITLE);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Finished')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this session?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete session' }).click();

  // Confirming lands back on the board with the session gone for good.
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  await expect(page.getByRole('main').getByRole('link', { name: new RegExp(TITLE) })).toHaveCount(
    0,
  );
  await page.goto('/archived');
  await expect(page.getByRole('listitem').filter({ hasText: TITLE })).toHaveCount(0);
});

test('delete can also reap the worktree + branch (Phase C T3 opt-in)', async ({ page }) => {
  const TITLE = `Reap on delete ${Date.now()}`;
  await signIn(page);
  await launchToCompletion(page, TITLE);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Finished')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this session?' });
  await expect(dialog).toBeVisible();
  // The opt-in exists for this launched session (its daemon is online) and defaults OFF.
  const reapSwitch = dialog.getByRole('switch', { name: 'Also remove its worktree and branch' });
  await expect(reapSwitch).toHaveAttribute('aria-checked', 'false');
  await reapSwitch.click();
  await dialog.getByRole('button', { name: 'Delete session' }).click();

  // The (fake) daemon reaped, then the delete completed — board, no row, no error notice.
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  await expect(page.getByRole('main').getByRole('link', { name: new RegExp(TITLE) })).toHaveCount(
    0,
  );
});

test('a dirty worktree cancels the delete with the honest story (session kept)', async ({
  page,
}) => {
  const TITLE = `leave the worktree dirty ${Date.now()}`;
  await signIn(page);
  await launchToCompletion(page, TITLE);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Finished')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this session?' });
  await dialog.getByRole('switch', { name: 'Also remove its worktree and branch' }).click();
  await dialog.getByRole('button', { name: 'Delete session' }).click();

  // The daemon refused (dirty): the dialog closes, the session SURVIVES, and the story is told.
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/uncommitted changes/)).toBeVisible({ timeout: 10_000 });
  await page.goto('/');
  await expect(page.getByRole('main').getByRole('link', { name: new RegExp(TITLE) })).toHaveCount(
    1,
    { timeout: 10_000 },
  );
});

test('"Load more" pages the ended group beyond the first page', async ({ page }) => {
  await seedEndedRows('Paged session', SEEDED, false);
  const oldestSeeded = `Paged session ${SEEDED - 1} ${RUN_ID}`;

  await signIn(page);
  // Page 1 is bounded: the oldest seeded row is beyond it, and the pager offers more.
  const loadMore = page.getByRole('button', { name: 'Load more' });
  await expect(loadMore).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: oldestSeeded })).toHaveCount(0);

  await loadMore.click();
  // The next page appends under the first — the once-hidden oldest row is now on the board.
  await expect(page.getByRole('link', { name: oldestSeeded })).toHaveCount(1, { timeout: 10_000 });
});

test('"Load more" pages the archived view too', async ({ page }) => {
  await seedEndedRows('Paged archive', SEEDED, true);
  const oldestSeeded = `Paged archive ${SEEDED - 1} ${RUN_ID}`;

  await signIn(page);
  await page.goto('/archived');
  const loadMore = page.getByRole('button', { name: 'Load more' });
  await expect(loadMore).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: oldestSeeded })).toHaveCount(0);

  await loadMore.click();
  await expect(page.getByRole('link', { name: oldestSeeded })).toHaveCount(1, { timeout: 10_000 });
});

test('housekeeping never appears on a session that is still going', async ({ page }) => {
  const TITLE = `Still running ${Date.now()}`;
  await signIn(page);
  await page.getByRole('button', { name: 'Launch session' }).first().click();
  await page.getByLabel('First instruction').fill(TITLE);
  await page.getByRole('button', { name: /Launch on/ }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

  // Blocked on its gate (awaiting input) — even with the registry row present after a reload, an
  // un-ended session offers no Archive/Delete.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);

  // Settle the session so the run leaves nothing hanging.
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Finished')).toBeVisible();
});
