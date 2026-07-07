<script lang="ts">
  import { isValidGitBranchName } from '@telecode/protocol';
  import { FieldNote, SelectField, Switch } from '@telecode/ui';

  import { forkBaseOptions } from '$lib/fork-branch';
  import { requestSessionBranches, sessionBranches } from '$lib/session-store';

  /**
   * The resume-as-new dock's branch control (branch-actions T5). Off (default) = the fork inherits
   * the parent's worktree, exactly the pre-T5 behavior. On = the child gets its OWN worktree, cut
   * from a picked base (the parent's branch first — the daemon-side default) with an optional
   * custom name, inline-validated by the shared wire rule. Reports upward on every change; the
   * page blocks the send while the name is invalid (never a silent fallback).
   */
  let {
    sessionId,
    parentBranch,
    disabled = false,
    onchange,
  }: {
    sessionId: string;
    /** The parent's branch from its sealed identity; undefined when this browser never learned it. */
    parentBranch: string | undefined;
    disabled?: boolean;
    onchange: (
      choice: { baseBranch: string; branchName?: string } | undefined,
      valid: boolean,
    ) => void;
  } = $props();

  let wantNew = $state(false);
  let base = $state('');
  let name = $state('');

  const options = $derived(forkBaseOptions(parentBranch, $sessionBranches.get(sessionId)));
  const nameInvalid = $derived(name !== '' && !isValidGitBranchName(name));

  function toggle(): void {
    wantNew = !wantNew;
    if (wantNew) {
      base = parentBranch ?? '';
      requestSessionBranches(sessionId);
    }
  }

  // One reporting point: the page always holds the CURRENT choice + its validity.
  $effect(() => {
    if (!wantNew || base === '') {
      onchange(undefined, true);
      return;
    }
    onchange(
      { baseBranch: base, ...(name !== '' && !nameInvalid ? { branchName: name } : {}) },
      !nameInvalid,
    );
  });
</script>

<div class="fork-branch">
  <div class="row">
    <Switch
      label="Start the new session on a new branch"
      checked={wantNew}
      {disabled}
      onclick={toggle}
    />
    <span class="row-label">Start on a new branch</span>
  </div>
  {#if wantNew}
    <div class="fields">
      {#if options.length === 0}
        <FieldNote>No branch list available — the fork will continue in place.</FieldNote>
      {:else}
        <SelectField id="fork-base-{sessionId}" label="From base" bind:value={base} {disabled}>
          {#each options as option (option)}
            <option value={option}>
              {option}{option === parentBranch ? ' (parent)' : ''}
            </option>
          {/each}
        </SelectField>
      {/if}
      <label class="lbl" for="fork-name-{sessionId}">New branch name (optional)</label>
      <input
        id="fork-name-{sessionId}"
        class="mono"
        type="text"
        placeholder="auto-named from your message"
        bind:value={name}
        {disabled}
        aria-invalid={nameInvalid}
      />
      {#if nameInvalid}
        <FieldNote tone="danger">Not a valid git branch name.</FieldNote>
      {/if}
    </div>
  {/if}
</div>

<style>
  .fork-branch {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-muted);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .row-label {
    font-size: var(--text-sm);
    color: var(--text);
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .lbl {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  input {
    width: 100%;
    padding: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  input::placeholder {
    color: var(--text-muted);
  }
</style>
