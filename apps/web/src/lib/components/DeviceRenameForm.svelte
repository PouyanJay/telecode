<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button, IconButton, Input } from '@telecode/ui';
  import { tick } from 'svelte';

  /**
   * Inline device rename (ux Phase 6 T6). A pencil next to the device name opens a small form that posts
   * to the page's `?/rename` action (a device name is a cleartext hostname, so no client sealing). On
   * success SvelteKit reruns the page load, so the new name renders; Escape/Cancel closes the editor.
   */
  let { deviceId, name }: { deviceId: string; name: string } = $props();

  let editing = $state(false);
  let draft = $state('');
  let submitting = $state(false);
  let error = $state<string | undefined>(undefined);
  let inputEl = $state<HTMLInputElement | null>(null);

  async function startEditing(): Promise<void> {
    draft = name;
    error = undefined;
    editing = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  /** The `fail(...)` payload this action returns is `{ error?: string }`. */
  function failureMessage(data: Record<string, unknown> | undefined): string {
    return typeof data?.error === 'string' ? data.error : 'Could not rename this device.';
  }
</script>

{#if editing}
  <form
    class="rename"
    method="POST"
    action="?/rename"
    use:enhance={() => {
      submitting = true;
      error = undefined;
      return async ({ result, update }) => {
        submitting = false;
        if (result.type === 'success') editing = false;
        else if (result.type === 'failure') error = failureMessage(result.data);
        // Keep the draft on failure so the user can fix it; success closes the editor anyway.
        await update({ reset: false });
      };
    }}
  >
    <input type="hidden" name="deviceId" value={deviceId} />
    <Input
      bind:value={draft}
      bind:ref={inputEl}
      name="name"
      label="Device name"
      hideLabel
      maxlength={128}
      disabled={submitting}
      {error}
      onkeydown={(e) => {
        if (e.key === 'Escape') editing = false;
      }}
    />
    <Button type="submit" variant="primary" size="sm" loading={submitting}>Save</Button>
    <Button type="button" variant="ghost" size="sm" disabled={submitting} onclick={() => (editing = false)}>
      Cancel
    </Button>
  </form>
{:else}
  <span class="name-row">
    <span class="name" title={name}>{name}</span>
    <IconButton label="Rename {name}" variant="ghost" size="sm" onclick={startEditing}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M9.5 2.5l2 2L5 11l-2.5.5L3 9l6.5-6.5z"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
      </svg>
    </IconButton>
  </span>
{/if}

<style>
  .name-row {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name-row :global(button) {
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .name-row:hover :global(button),
  .name-row:focus-within :global(button) {
    opacity: 1;
  }
  .rename {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }
  .rename :global(.field) {
    flex: 1;
    min-width: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .name-row :global(button) {
      transition: none;
    }
  }
  @media (hover: none) {
    .name-row :global(button) {
      opacity: 1;
    }
  }
</style>
