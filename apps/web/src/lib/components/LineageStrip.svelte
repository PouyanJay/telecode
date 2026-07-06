<script lang="ts">
  import { clockTime } from '$lib/clock-time';
  import { segmentLabel, type ThreadSegment } from '$lib/threads';

  /**
   * The session view's lineage strip (ux Phase 3, B2): one cell per segment of the conversation —
   * where it ran, when it began, and how many entries are known — welded into a hairline band under
   * the header. The open segment is highlighted (amber edge, the "you are here" tick); every other
   * segment is a real link that jumps to it. Rendered only for chained sessions.
   */
  let {
    segments,
    entryCountOf,
  }: {
    segments: readonly ThreadSegment[];
    /** Known transcript length for a segment (live/subscribed sessions), or null when unknown. */
    entryCountOf: (sessionId: string) => number | null;
  } = $props();
</script>

{#snippet cellContent(segment: ThreadSegment, index: number)}
  {@const count = entryCountOf(segment.sessionId)}
  <span class="eyebrow">SEGMENT {index + 1} · {segmentLabel(segment.origin)}</span>
  <span class="meta mono">
    {index > 0 ? 'taken over ' : 'started '}{clockTime(segment.startedAt)}{count !== null
      ? ` · ${count} ${count === 1 ? 'entry' : 'entries'}`
      : ''}
  </span>
{/snippet}

<nav class="strip hairline-b" aria-label="Conversation lineage">
  <ol class="segs" role="list">
    {#each segments as segment, i (segment.sessionId)}
      <li class="seg hairline-r" class:current={segment.isCurrent}>
        {#if segment.isCurrent}
          <span class="cell" aria-current="page">
            {@render cellContent(segment, i)}
          </span>
        {:else}
          <a class="cell" href="/sessions/{segment.sessionId}">
            {@render cellContent(segment, i)}
          </a>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .strip {
    background: var(--surface);
    overflow-x: auto;
  }
  .segs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    min-width: max-content;
  }
  .seg {
    display: flex;
  }
  .hairline-r {
    border-right: 1px solid var(--border);
  }
  @media (min-resolution: 2dppx) {
    .hairline-r {
      border-right-width: 0.5px;
    }
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-4);
    text-decoration: none;
    color: var(--text-secondary);
    /* The current tick rides the bottom edge, like the active-nav indicator. */
    border-bottom: 2px solid transparent;
    transition: background-color var(--dur-fast) var(--ease);
  }
  a.cell:hover {
    background: var(--bg-muted);
    color: var(--text);
  }
  a.cell:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
  }
  .seg.current .cell {
    border-bottom-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .seg.current .eyebrow {
    color: var(--text-secondary);
  }
  .meta {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
