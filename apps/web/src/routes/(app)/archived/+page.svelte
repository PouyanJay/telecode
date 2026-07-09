<script lang="ts">
  import { Button, ConfirmDialog, StatusDot } from '@telecode/ui';

  import { invalidateAll } from '$app/navigation';

  import { sessionDeleteBody } from '$lib/delete-copy';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import RegistryErrorNotice from '$lib/components/RegistryErrorNotice.svelte';
  import SessionNotice from '$lib/components/SessionNotice.svelte';
  import { appendSessionRows, type SessionPageRow } from '$lib/housekeeping';
  import { createSessionPager } from '$lib/session-pager.svelte';
  import { SESSION_DISPLAY } from '$lib/session-display';
  import type { RegistrySessionRow } from '$lib/session-groups';
  import {
    deleteSessionForever,
    restoreSession,
    seedSessionMetas,
    seedSessionTitleOverrides,
    sessionMetas,
    sessionTitleOverrides,
  } from '$lib/session-store';
  import { relativeTime } from '$lib/time';
  import type { PageData } from './$types';

  /**
   * The archived view (ux Phase 6 T7): terminal sessions the user shelved off the board. Each row can be
   * restored (back to Recent, at its true recency) or deleted for good (ConfirmDialog — the one
   * irreversible action). Paginated like the board's ended group.
   */
  let { data }: { data: PageData } = $props();

  // Pages past the first: the shared pager (a load-refresh after unarchive/delete resets to the
  // fresh page 1); fetched pages seed their sealed titles like the first page below.
  const pager = createSessionPager({
    archived: true,
    onPage: (fetched) => {
      seedSessionMetas(fetched);
      seedSessionTitleOverrides(fetched);
    },
  });
  $effect(() => pager.reset(data.archivedCursor));

  // Typed as page rows (registry shape + archivedAt) — the "archived N ago" meta line needs the stamp.
  const rows = $derived(appendSessionRows<SessionPageRow>(data.archivedSessions, pager.extraRows));

  // The server-loaded first page carries sealed blobs too — decode titles into the shared maps.
  $effect(() => {
    seedSessionMetas(data.archivedSessions);
    seedSessionTitleOverrides(data.archivedSessions);
  });

  const ID_PREFIX = 12;
  const titleOf = $derived(
    (row: RegistrySessionRow): string =>
      $sessionTitleOverrides.get(row.id) ??
      $sessionMetas.get(row.id)?.title ??
      row.title ??
      row.id.slice(0, ID_PREFIX),
  );
  const deviceNameOf = $derived(
    (deviceId: string): string | null => data.devices.find((d) => d.id === deviceId)?.name ?? null,
  );

  let busyId = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let confirmDelete = $state<{ id: string; title: string } | null>(null);
  let deleteDialogOpen = $state(false);
  let deleteBusy = $state(false);

  function askDelete(id: string, title: string): void {
    confirmDelete = { id, title };
    deleteDialogOpen = true;
  }

  async function onUnarchive(id: string): Promise<void> {
    actionError = null;
    busyId = id;
    const result = await restoreSession(id);
    busyId = null;
    if (!result.ok) {
      actionError = result.error;
      return;
    }
    await invalidateAll();
  }

  async function onDeleteConfirm(): Promise<void> {
    if (!confirmDelete) return;
    actionError = null;
    deleteBusy = true;
    const result = await deleteSessionForever(confirmDelete.id);
    deleteBusy = false;
    deleteDialogOpen = false;
    confirmDelete = null;
    if (!result.ok) {
      actionError = result.error;
      return;
    }
    await invalidateAll();
  }

  // The shared consequence copy (delete-copy.ts), led by the row's own title.
  const deleteBody = $derived(sessionDeleteBody({ title: confirmDelete?.title ?? '' }));
</script>

<svelte:head>
  <title>Archived · telecode</title>
</svelte:head>

<PageHeader title="Archived" sub="Ended sessions you shelved off the board. Restore or delete them." />

<div class="scroll">
  {#if data.archivedError}
    <RegistryErrorNotice />
  {:else}
    <div class="list">
      {#if actionError}
        <SessionNotice message={actionError} tone="danger" ondismiss={() => (actionError = null)} />
      {/if}
      {#if rows.length === 0}
        <div class="empty">
          <p class="eyebrow">Nothing archived</p>
          <p class="sub">Archive an ended session from its page to tidy the board.</p>
          <a class="back-link" href="/">← Back to sessions</a>
        </div>
      {:else}
        <ul class="rows" role="list">
          {#each rows as row (row.id)}
            {@const display = SESSION_DISPLAY[row.status]}
            <li class="row hairline-b">
              <span class="status">
                <StatusDot tone={display.tone} label={display.label} />
              </span>
              <span class="titlecell">
                <a class="title" href={`/sessions/${row.id}`} title={titleOf(row)}>
                  {titleOf(row)}
                </a>
                <span class="meta mono">
                  {#if deviceNameOf(row.deviceId)}{deviceNameOf(row.deviceId)} · {/if}archived
                  {relativeTime(row.archivedAt ?? row.updatedAt)}
                </span>
              </span>
              <span class="actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === row.id}
                  onclick={() => onUnarchive(row.id)}
                >
                  {busyId === row.id ? 'Restoring…' : 'Restore'}
                </Button>
                <Button variant="danger" size="sm" onclick={() => askDelete(row.id, titleOf(row))}>
                  Delete
                </Button>
              </span>
            </li>
          {/each}
        </ul>
        {#if pager.cursor !== null}
          <div class="load-more">
            <Button variant="ghost" size="sm" disabled={pager.loading} onclick={pager.loadMore}>
              {pager.loading ? 'Loading…' : 'Load more'}
            </Button>
            {#if pager.failed}
              <span class="load-more-error" role="status">
                Couldn’t load more sessions — try again.
              </span>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<ConfirmDialog
  bind:open={deleteDialogOpen}
  title="Delete this session?"
  body={deleteBody}
  confirmLabel="Delete session"
  confirmTone="danger"
  busy={deleteBusy}
  onconfirm={onDeleteConfirm}
  oncancel={() => (confirmDelete = null)}
/>

<style>
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .list {
    max-width: 72rem;
    padding: var(--space-4) var(--space-4) var(--space-8);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: 148px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
  }
  .status {
    min-width: 0;
  }
  .titlecell {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
    text-decoration: none;
    border-radius: var(--radius-sm);
    justify-self: start;
  }
  .title:hover {
    text-decoration: underline;
  }
  .title:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .meta {
    font-size: var(--text-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }
  .load-more {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-2);
  }
  .load-more-error {
    font-size: var(--text-xs);
    color: var(--danger);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    text-align: center;
    padding: var(--space-16) var(--space-4);
  }
  .eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .empty .sub {
    margin: 0;
    max-width: 28rem;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .back-link {
    color: var(--accent);
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .back-link:hover {
    text-decoration: underline;
  }
  .back-link:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }

  @media (max-width: 640px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .status {
      display: none;
    }
  }
</style>
