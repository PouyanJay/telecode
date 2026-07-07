<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * A quiet, mono, form-adjacent status line (loading notes, refusal stories, pushed
   * confirmations). `tone="danger"` marks an error and defaults its ARIA role to `alert`;
   * pass `role="status"` for live-but-calm notes screen readers should still announce.
   */
  let {
    tone = 'muted',
    role,
    children,
  }: {
    tone?: 'muted' | 'danger';
    role?: 'alert' | 'status';
    children: Snippet;
  } = $props();

  const ariaRole = $derived(role ?? (tone === 'danger' ? 'alert' : undefined));
</script>

<p class="note mono" class:danger={tone === 'danger'} role={ariaRole}>{@render children()}</p>

<style>
  .note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .note.danger {
    color: var(--danger);
  }
</style>
