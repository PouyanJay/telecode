<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * A labeled, token-styled native select for machine-generated values (branch names, refs —
   * hence mono). The parent owns the option list via `children`; `value` is bindable. A native
   * control on purpose: full keyboard operability and the platform's own picker for free.
   */
  let {
    id,
    label,
    value = $bindable(''),
    disabled = false,
    children,
  }: {
    id: string;
    label: string;
    value?: string;
    disabled?: boolean;
    children: Snippet;
  } = $props();
</script>

<label class="lbl" for={id}>{label}</label>
<select {id} class="mono" bind:value {disabled}>
  {@render children()}
</select>

<style>
  .lbl {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  select {
    width: 100%;
    padding: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
