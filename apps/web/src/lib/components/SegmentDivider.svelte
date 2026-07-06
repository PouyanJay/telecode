<script lang="ts">
  /**
   * The takeover moment made explicit in the transcript (ux Phase 3, B2): a hairline rule carrying a
   * mono label — "Taken over in telecode · 4:02 PM" in the continuation's view, or (with `href`) the
   * forward pointer "Continued in telecode → open segment 2" in the superseded segment's view, so a
   * takeover reads as a move in one story, never as the session's death.
   */
  let { label, href }: { label: string; href?: string } = $props();
</script>

<div class="divider" role="separator" aria-label={label}>
  <span class="rule" aria-hidden="true"></span>
  {#if href !== undefined}
    <a class="label mono" {href}>{label}</a>
  {:else}
    <span class="label mono">{label}</span>
  {/if}
  <span class="rule" aria-hidden="true"></span>
</div>

<style>
  .divider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-2) 0;
  }
  .rule {
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  @media (min-resolution: 2dppx) {
    .rule {
      height: 0.5px;
    }
  }
  .label {
    flex: none;
    font-size: var(--text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    white-space: nowrap;
  }
  a.label {
    text-decoration: none;
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
  }
  a.label:hover {
    color: var(--text);
    text-decoration: underline;
  }
  a.label:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
  }
</style>
