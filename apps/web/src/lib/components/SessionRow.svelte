<script lang="ts">
  import { Pill, StatusDot } from '@telecode/ui';

  import { SESSION_DISPLAY } from '$lib/session-display';
  import { segmentLabel, type ThreadRow } from '$lib/threads';
  import { clockTime, relativeTime } from '$lib/time';

  /**
   * One thread in the dashboard list (enterprise-ui §7): a full-row `<a href>` to the session, with the
   * house status (dot + UPPERCASE-mono label), the title (ellipsis + tooltip for long ones), the device it
   * runs on, and a relative timestamp. An awaiting-input row carries the amber tint + accent edge — the one
   * "needs you" signal. A chained thread (ux Phase 3) shows a segment crumb under the title — origin and
   * each hop with its time, the current segment ticked amber — replacing the origin pills; taking a session
   * over reads as a move, not a death. Only fields we actually persist are shown.
   */
  let { row }: { row: ThreadRow } = $props();

  const display = $derived(SESSION_DISPLAY[row.status]);
  const isAwaiting = $derived(row.status === 'awaiting_input');
  const isChained = $derived(row.segments.length > 0);
  // Sessions telecode adopted from the user's own Claude Code runs (terminal / IDE) are marked, so the
  // operator can tell them from sessions launched here — they're monitored + gated, not telecode-driven.
  const isAdopted = $derived(row.origin === 'external');
</script>

<a class="row hairline-b" class:await={isAwaiting} href="/sessions/{row.id}">
  <span class="status">
    <StatusDot tone={display.tone} label={display.label} pulse={display.pulse} />
  </span>
  <span class="titlecell">
    <span class="titleline">
      <!-- At most one origin mark on an UNCHAINED row: adopted ("on device") or a continuation whose
           parent is unknown. A chained thread replaces the pills with the segment crumb below — the
           crumb carries both facts (origin AND the hop) with times. -->
      {#if !isChained}
        {#if isAdopted}
          <Pill label="on device" />
        {:else if row.isContinuation}
          <Pill label="continuation" />
        {/if}
      {/if}
      <span class="title" title={row.title ?? row.id}>{row.title ?? row.id}</span>
    </span>
    {#if isChained}
      <span class="crumb mono">
        {#each row.segments as segment, i (segment.sessionId)}
          {#if i > 0}<span class="sep" aria-hidden="true">→</span>{/if}
          <span class="seg" class:current={segment.isCurrent}>
            <span class="dot" aria-hidden="true"></span>
            {segmentLabel(segment.origin)} · {i > 0 ? 'taken over ' : ''}{clockTime(
              segment.startedAt,
            )}
          </span>
        {/each}
      </span>
    {/if}
  </span>
  {#if row.deviceName}
    <span class="device mono">{row.deviceName}</span>
  {/if}
  <span class="time mono">{relativeTime(row.createdAt)}</span>
  <span class="chev" aria-hidden="true">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </span>
</a>

<style>
  .row {
    display: grid;
    grid-template-columns: 148px minmax(0, 1fr) minmax(0, auto) auto 16px;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    color: var(--text);
    text-decoration: none;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }
  .row:hover {
    background: var(--bg-muted);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
  }
  .row.await {
    background: var(--accent-soft);
    border-color: var(--accent-line);
  }
  .row.await:hover {
    border-color: var(--accent);
  }
  .status {
    min-width: 0;
  }
  .titlecell {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .titleline {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  /* The segment crumb (ux Phase 3): origin → each hop with its time, current segment ticked amber.
     Machine data → mono; one line, ellipsized — a long chain must never wrap the row. */
  .crumb {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .seg {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
  }
  .sep {
    margin: 0 var(--space-2);
    color: var(--text-muted);
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: var(--radius-full);
    background: var(--text-muted);
    align-self: center;
    flex: none;
  }
  .seg.current .dot {
    background: var(--accent);
  }
  .seg.current {
    color: var(--text);
  }
  .device {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .time {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-align: right;
  }
  .chev {
    display: grid;
    place-items: center;
    color: var(--text-muted);
  }
  .row:hover .chev {
    color: var(--text-secondary);
  }

  @media (max-width: 860px) {
    .row {
      grid-template-columns: 148px minmax(0, 1fr) auto 16px;
    }
    .device {
      display: none;
    }
  }
  @media (max-width: 560px) {
    .row {
      grid-template-columns: auto 1fr auto;
      gap: var(--space-2) var(--space-3);
      grid-template-areas:
        'status status time'
        'title title title';
    }
    .status {
      grid-area: status;
    }
    .time {
      grid-area: time;
    }
    .titlecell {
      grid-area: title;
    }
    .title {
      white-space: normal;
    }
    .chev {
      display: none;
    }
  }
</style>
