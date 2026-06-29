<script lang="ts">
  import { StatusDot } from '@telecode/ui';

  import { SESSION_DISPLAY } from '$lib/session-display';
  import type { SessionRow } from '$lib/session-groups';
  import { relativeTime } from '$lib/time';

  /**
   * One session in the dashboard list (enterprise-ui §7): a full-row `<a href>` to the session, with the
   * house status (dot + UPPERCASE-mono label), the title (ellipsis + tooltip for long ones), the device it
   * runs on, and a relative timestamp. An awaiting-input row carries the amber tint + accent edge — the one
   * "needs you" signal. Only fields we actually persist are shown (no invented repo/branch/diff meta).
   */
  let { row }: { row: SessionRow } = $props();

  const display = $derived(SESSION_DISPLAY[row.status]);
  const awaiting = $derived(row.status === 'awaiting_input');
</script>

<a class="row hairline-b" class:await={awaiting} href="/sessions/{row.id}">
  <span class="status">
    <StatusDot tone={display.tone} label={display.label} pulse={display.pulse} />
  </span>
  <span class="title" title={row.title ?? row.id}>{row.title ?? row.id}</span>
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
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    font-weight: 500;
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
    .title {
      grid-area: title;
      white-space: normal;
    }
    .chev {
      display: none;
    }
  }
</style>
