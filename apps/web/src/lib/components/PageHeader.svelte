<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The standard route header (title + sub-line, hairline-divided from the scrollable body), shared by the
   * dashboard, Devices, and Settings so the type ramp + responsive padding live in one place. An optional
   * `actions` snippet fills the trailing edge (e.g. the dashboard's stat columns).
   */
  let { title, sub, actions }: { title: string; sub?: string; actions?: Snippet } = $props();
</script>

<header class="phead hairline-b">
  <div class="heading">
    <h1>{title}</h1>
    {#if sub}<p class="sub">{sub}</p>{/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>

<style>
  .phead {
    display: flex;
    align-items: flex-end;
    gap: var(--space-5);
    padding: var(--space-6) var(--space-6) var(--space-5);
    background: var(--surface);
  }
  .heading h1 {
    margin: 0;
    font-size: var(--text-2xl);
    line-height: var(--lh-2xl);
    font-weight: 600;
    letter-spacing: -0.03em;
  }
  .sub {
    margin: var(--space-1) 0 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .actions {
    margin-left: auto;
  }

  @media (max-width: 640px) {
    .phead {
      padding: var(--space-5) var(--space-4) var(--space-4);
    }
  }
</style>
