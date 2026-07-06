<script lang="ts">
  import { deviceBoardHref, type DeviceChip } from '$lib/device-filter';

  /**
   * Device chips scoping the dashboard (ux Phase 5, plan B4): `All devices / MacBook Pro ● /
   * mini-server ○`. Real links (`?device=` — the filter is URL state, so it reloads/shares), the
   * active scope carries `aria-current`, presence is a glyph + hidden text (never color alone),
   * and a chip with sessions blocked on the human wears the amber count.
   */
  let { chips, active }: { chips: DeviceChip[]; active: string | null } = $props();
</script>

<nav class="chips" aria-label="Filter sessions by device">
  {#each chips as chip (chip.id ?? '__all')}
    <a
      class="chip"
      href={deviceBoardHref(chip.id)}
      aria-current={active === chip.id ? 'true' : undefined}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
    >
      {#if chip.id !== null}
        <span class="mark" data-online={chip.online} aria-hidden="true">
          {chip.online ? '●' : '○'}
        </span>
        <span class="visually-hidden">{chip.online ? 'online' : 'offline'},</span>
      {/if}
      <span class="chip-label">{chip.label}</span>
      <span class="chip-count mono" aria-label="{chip.count} sessions">{chip.count}</span>
      {#if chip.needsYou > 0}
        <span class="badge mono" aria-label="{chip.needsYou} awaiting your decision">
          {chip.needsYou}
        </span>
      {/if}
    </a>
  {/each}
</nav>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 28px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--text-secondary);
    font-size: var(--text-xs);
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
  .mark {
    font-size: 9px;
    color: var(--text-muted);
    line-height: 1;
  }
  .mark[data-online='true'] {
    color: var(--success);
  }
  .chip-count {
    font-size: 10px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .badge {
    min-width: 16px;
    padding: 1px 5px;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--primary-text);
    font-size: 10px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
