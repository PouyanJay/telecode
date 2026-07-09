<script lang="ts">
  /**
   * An eyebrow label + hairline rule separating the dashboard's session groups (enterprise-ui §1).
   * An optional trailing link (e.g. "Archived →" on the Recent group, T7) sits after the rule.
   */
  let {
    label,
    note,
    actionHref,
    actionLabel,
  }: { label: string; note?: string; actionHref?: string; actionLabel?: string } = $props();
</script>

<div class="group">
  <span class="eyebrow">{label}</span>
  {#if note}
    <!-- Honesty note (board-housekeeping): e.g. "2 dismissed" — hidden cards never silently vanish
         from the count; muted, not amber (the chip on the row carries the act-now signal). -->
    <span class="note">{note}</span>
  {/if}
  <span class="rule" aria-hidden="true"></span>
  {#if actionHref && actionLabel}
    <a class="action" href={actionHref}>{actionLabel}</a>
  {/if}
</div>

<style>
  .group {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-2) var(--space-2);
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .note {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .rule {
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .action {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-secondary);
    text-decoration: none;
    white-space: nowrap;
    border-radius: var(--radius-sm);
    /* Pad the hit area up to target size without shifting the visual baseline. */
    padding: var(--space-2);
    margin: calc(-1 * var(--space-2));
  }
  .action:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .action:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
</style>
