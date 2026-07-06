<script lang="ts">
  import type { DiffStat } from '@telecode/protocol';

  /**
   * The gate's rough ±lines (mockup §01-4), shared by the inbox card and the transcript's permission
   * gate so a routine file edit is decidable at a glance. Mono, additions green / removals red — with
   * the numbers themselves carrying the meaning (never color alone).
   */
  let { stat }: { stat: DiffStat } = $props();
</script>

<span
  class="diffstat mono"
  aria-label="{stat.added} {stat.added === 1 ? 'line' : 'lines'} added, {stat.removed} {stat.removed === 1
    ? 'line'
    : 'lines'} removed"
>
  <span class="plus">+{stat.added}</span>
  <span class="minus">−{stat.removed}</span>
</span>

<style>
  .diffstat {
    display: inline-flex;
    gap: var(--space-2);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .plus {
    color: var(--success);
  }
  .minus {
    color: var(--danger);
  }
</style>
