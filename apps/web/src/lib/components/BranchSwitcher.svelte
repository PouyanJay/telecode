<script lang="ts">
  import { Button, FieldNote, SelectField } from '@telecode/ui';

  import {
    requestSessionBranches,
    sessionBranches,
    switchSessionBranch,
    type BranchSwitchOutcome,
  } from '$lib/session-store';

  /**
   * The rail's between-turns branch switch (branch-actions T4, enterprise-ui states contract):
   * closed → a quiet ghost affordance; open → a labeled select fed by the session-scoped sealed
   * branch listing (loading / unavailable / loaded), Apply with a busy state, and every refusal
   * retold inline from the daemon's coded verdict. The branch ROW itself updates only via the
   * daemon's `session.meta` re-emit — never optimistically.
   */
  let {
    sessionId,
    currentBranch,
  }: {
    sessionId: string;
    /** What the worktree is on now — excluded from the choices (switching to it is a no-op). */
    currentBranch: string;
  } = $props();

  let open = $state(false);
  let picked = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const listing = $derived($sessionBranches.get(sessionId));
  const choices = $derived((listing?.branches ?? []).filter((branch) => branch !== currentBranch));

  // Typed against the outcome union: adding a failure reason without copy is a compile error.
  const SWITCH_STORIES: Record<Extract<BranchSwitchOutcome, { ok: false }>['reason'], string> = {
    'mid-turn': 'A turn is running — switch between turns.',
    ended: 'This session can no longer take follow-ups.',
    'not-launched': 'Only telecode-launched sessions can switch.',
    dirty: 'The worktree has uncommitted changes — settle them first.',
    'not-found': 'That branch no longer exists on the device.',
    'checked-out-elsewhere': 'That branch is checked out in another worktree.',
    failed: 'The device could not switch. Nothing changed.',
    'daemon-offline': 'The device went offline — nothing changed.',
    timeout: 'The device did not answer in time — nothing changed.',
    'no-connection': 'No connection to the session’s device.',
  };

  function openPicker(): void {
    error = null;
    picked = '';
    open = true;
    requestSessionBranches(sessionId);
  }

  function cancel(): void {
    if (busy) return;
    open = false;
    error = null;
  }

  async function apply(): Promise<void> {
    if (picked === '' || busy) return;
    busy = true;
    error = null;
    const outcome = await switchSessionBranch(sessionId, picked);
    busy = false;
    if (outcome.ok) {
      open = false; // the Branch row follows the daemon's meta re-emit
      return;
    }
    error = SWITCH_STORIES[outcome.reason];
  }
</script>

<div class="switcher">
  {#if !open}
    <Button variant="ghost" size="sm" onclick={openPicker}>Switch branch</Button>
  {:else}
    <div class="picker">
      {#if listing === undefined}
        <FieldNote role="status">Loading branches…</FieldNote>
      {:else if !listing.available || choices.length === 0}
        <FieldNote>No other branch to switch to.</FieldNote>
      {:else}
        <SelectField
          id="switch-branch-{sessionId}"
          label="Switch to"
          bind:value={picked}
          disabled={busy}
        >
          <option value="" disabled>Pick a branch…</option>
          {#each choices as branch (branch)}
            <option value={branch}>{branch}</option>
          {/each}
        </SelectField>
      {/if}
      {#if error}
        <FieldNote tone="danger">{error}</FieldNote>
      {/if}
      <div class="row">
        <Button variant="ghost" size="sm" onclick={cancel} disabled={busy}>Cancel</Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={picked === ''}
          onclick={apply}
        >
          Switch
        </Button>
      </div>
    </div>
  {/if}
</div>

<style>
  .switcher {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: var(--space-1) 0 var(--space-2);
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-muted);
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
