<script lang="ts">
  import { buildFileDiff } from '$lib/diff';
  import { summarizeTool } from '$lib/tool-summary';

  import Code from './Code.svelte';
  import DiffView from './DiffView.svelte';

  /**
   * A collapsible tool-log entry (enterprise-ui §7, Phase 4 T11): a compact monospace row — `→ Read ·
   * src/a.ts` — that expands to the full input. A native `<details>`/`<summary>` disclosure carries the
   * keyboard + screen-reader semantics (Enter/Space toggles, expanded/collapsed announced) for free; the
   * default marker is swapped for a chevron that rotates on open. A file-edit tool reveals its diff
   * (reusing {@link DiffView}); everything else reveals highlighted JSON. A tool with no detail renders as
   * a plain, non-interactive row.
   */
  let { toolName, input }: { toolName: string; input: Record<string, unknown> } = $props();

  const summary = $derived(summarizeTool(toolName, input));
  const diff = $derived(buildFileDiff(toolName, input));
  const inputJson = $derived(JSON.stringify(input, null, 2));
  const hasDetail = $derived(diff !== null || inputJson !== '{}');
</script>

{#snippet row()}
  <span class="sr-only">Tool call:</span>
  <span class="glyph" aria-hidden="true">→</span>
  <code class="name">{toolName}</code>
  {#if summary}
    <span class="sep" aria-hidden="true">·</span>
    <span class="summary" title={summary}>{summary}</span>
  {/if}
{/snippet}

{#if hasDetail}
  <details class="tool">
    <summary class="rowline">
      {@render row()}
      <svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M4.5 2.5L8 6l-3.5 3.5"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </summary>
    <div class="detail">
      {#if diff}
        <DiffView {diff} />
      {:else}
        <Code code={inputJson} language="json" />
      {/if}
    </div>
  </details>
{:else}
  <div class="rowline static">{@render row()}</div>
{/if}

<style>
  .tool {
    border-left: 1px solid var(--border-strong);
  }
  .rowline {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-left: 1px solid var(--border-strong);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-secondary);
    min-width: 0;
  }
  /* The summary owns the left rail when inside <details>; avoid doubling it. */
  .tool > .rowline {
    border-left: none;
  }
  details > summary.rowline {
    cursor: pointer;
    list-style: none;
  }
  summary.rowline::-webkit-details-marker {
    display: none;
  }
  summary.rowline:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
    border-radius: var(--radius-sm);
  }
  .glyph {
    color: var(--text-muted);
    flex: none;
  }
  .name {
    color: var(--text);
    flex: none;
  }
  .sep {
    color: var(--text-muted);
    flex: none;
  }
  .summary {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .chev {
    margin-left: auto;
    flex: none;
    color: var(--text-muted);
    transition: transform var(--dur-fast) var(--ease);
  }
  details[open] > summary .chev {
    transform: rotate(90deg);
  }
  .detail {
    padding: var(--space-1) var(--space-2) var(--space-2) var(--space-4);
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
