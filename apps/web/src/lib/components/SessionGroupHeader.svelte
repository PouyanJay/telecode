<script lang="ts">
  /** An eyebrow label + hairline rule separating the dashboard's session groups (enterprise-ui §1). */
  let { label }: { label: string } = $props();
</script>

<div class="group">
  <span class="eyebrow">{label}</span>
  <span class="rule" aria-hidden="true"></span>
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
  .rule {
    flex: 1;
    height: 1px;
    background: var(--border);
  }
</style>
