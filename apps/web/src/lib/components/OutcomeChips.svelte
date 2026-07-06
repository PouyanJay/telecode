<script lang="ts">
  import { outcomeBoardHref, type OutcomeChip } from '$lib/outcome-filter';

  /**
   * Outcome chips scoping the ended group (mockup §01-7): `ALL / COMPLETED / FAILED / …`. Real links
   * (`?outcome=` — the filter is URL state, so it reloads/shares and composes with the device scope);
   * the active scope carries `aria-current`. Rendered by the dashboard only when 2+ endings coexist.
   */
  let {
    chips,
    active,
    search,
  }: {
    chips: OutcomeChip[];
    active: string | null;
    /** The page's current query — hrefs preserve the other filters (device scope). */
    search: URLSearchParams;
  } = $props();
</script>

<nav class="chips" aria-label="Filter ended sessions by outcome">
  {#each chips as chip (chip.outcome ?? '__all')}
    <a
      class="chip mono"
      href={outcomeBoardHref(chip.outcome, search)}
      aria-current={active === chip.outcome ? 'true' : undefined}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
    >
      <span class="chip-label">{chip.label}</span>
      <span class="chip-count" aria-label="{chip.count} sessions">{chip.count}</span>
    </a>
  {/each}
</nav>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2) var(--space-2);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 24px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--text-secondary);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-decoration: none;
    white-space: nowrap;
    transition:
      color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease);
  }
  .chip:hover {
    color: var(--text);
    background: var(--bg-muted);
  }
  .chip:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .chip[aria-current='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }
  .chip-count {
    font-size: 10px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
