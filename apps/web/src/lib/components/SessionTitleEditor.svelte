<script lang="ts">
  import { Button, IconButton, Input } from '@telecode/ui';
  import { tick } from 'svelte';

  import type { SessionActionResult } from '$lib/session-store';

  /**
   * The session title with an inline rename affordance (ux Phase 6 T6). View mode shows the title + a
   * pencil button; edit mode swaps in a text field with Save / Cancel (and Reset-to-default when the user
   * has an override). The new title is sealed client-side by the caller's `onrename` — this component only
   * owns the edit UX. Enter saves, Escape cancels; errors render inline. Keeps the header's single H1.
   */
  let {
    title,
    canReset,
    onrename,
    onreset,
  }: {
    title: string;
    /** Whether a user override exists (so "Reset to default" is offered). */
    canReset: boolean;
    onrename: (title: string) => Promise<SessionActionResult>;
    onreset: () => Promise<SessionActionResult>;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let error = $state<string | undefined>(undefined);
  let busy = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);

  async function startEditing(): Promise<void> {
    draft = title;
    error = undefined;
    editing = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  function cancel(): void {
    editing = false;
    error = undefined;
  }

  async function save(): Promise<void> {
    const next = draft.trim();
    if (next === '') {
      error = 'Enter a name.';
      return;
    }
    if (next === title) {
      cancel();
      return;
    }
    busy = true;
    error = undefined;
    const result = await onrename(next);
    busy = false;
    if (result.ok) editing = false;
    else error = result.error;
  }

  async function reset(): Promise<void> {
    busy = true;
    error = undefined;
    const result = await onreset();
    busy = false;
    if (result.ok) editing = false;
    else error = result.error;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }
</script>

{#if editing}
  <div class="editor">
    <div class="row">
      <Input
        bind:value={draft}
        bind:ref={inputEl}
        label="Session name"
        hideLabel
        maxlength={512}
        disabled={busy}
        {onkeydown}
        {error}
      />
      <Button variant="primary" size="sm" loading={busy} onclick={save}>Save</Button>
      <Button variant="ghost" size="sm" disabled={busy} onclick={cancel}>Cancel</Button>
    </div>
    {#if canReset}
      <button class="reset" type="button" disabled={busy} onclick={reset}>
        Reset to default name
      </button>
    {/if}
  </div>
{:else}
  <div class="view">
    <h1 class="ttl" title={title}>{title}</h1>
    <IconButton label="Rename session" variant="ghost" size="sm" onclick={startEditing}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M9.5 2.5l2 2L5 11l-2.5.5L3 9l6.5-6.5z"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
      </svg>
    </IconButton>
  </div>
{/if}

<style>
  .view {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .ttl {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The rename button stays quiet until the title is hovered/focused — an accent scalpel, not a shout. */
  .view :global(button) {
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .view:hover :global(button),
  .view:focus-within :global(button) {
    opacity: 1;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    flex: 1;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }
  .row :global(.field) {
    flex: 1;
    min-width: 0;
  }
  .reset {
    align-self: flex-start;
    padding: 0;
    background: none;
    border: none;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--text-muted);
    cursor: pointer;
    text-decoration: underline;
  }
  .reset:hover:not(:disabled) {
    color: var(--text-secondary);
  }
  .reset:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .view :global(button) {
      transition: none;
    }
  }
  /* Touch devices have no hover — keep the rename button always visible there. */
  @media (hover: none) {
    .view :global(button) {
      opacity: 1;
    }
  }
</style>
