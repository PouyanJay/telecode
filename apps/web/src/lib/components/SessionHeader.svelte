<script lang="ts">
  import { Button, Pill, type PillTone } from '@telecode/ui';

  import { SESSION_DISPLAY } from '$lib/session-display';
  import type { SessionStatus } from '$lib/session';

  /**
   * The session-view header (enterprise-ui §7): a back link to the list, the session title + the machine
   * it runs on, the live status pill, and the operator controls (Interrupt / End). Controls are disabled
   * off a live channel and never optimistic — the daemon reports the resulting status. Only real metadata
   * is shown (the device + short id; no invented repo/branch/worktree path).
   */
  let {
    title,
    deviceName,
    sessionId,
    status,
    isBusy,
    isTerminal,
    showControls,
    connected,
    oninterrupt,
    onend,
  }: {
    title: string;
    deviceName: string | null;
    sessionId: string;
    status: SessionStatus;
    isBusy: boolean;
    isTerminal: boolean;
    showControls: boolean;
    connected: boolean;
    oninterrupt: () => void;
    onend: () => void;
  } = $props();

  const display = $derived(SESSION_DISPLAY[status]);
  const tone = $derived<PillTone>(display.tone === 'muted' ? 'neutral' : display.tone);
</script>

<header class="shead hairline-b">
  <a class="back" href="/" aria-label="Back to sessions">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </a>

  <div class="mid">
    <h1 class="ttl" title={title}>{title}</h1>
    <p class="path mono">
      {#if deviceName}<span class="dev">{deviceName}</span> · {/if}<span class="sid">{sessionId.slice(0, 12)}</span>
    </p>
  </div>

  <Pill {tone} dot pulse={display.pulse} label={display.label} aria-live="polite" />

  {#if showControls}
    <div class="ctrls">
      {#if isBusy}
        <Button variant="ghost" size="sm" disabled={!connected} onclick={oninterrupt}>Interrupt</Button>
      {/if}
      {#if !isTerminal}
        <Button variant="danger" size="sm" disabled={!connected} onclick={onend}>End</Button>
      {/if}
    </div>
  {/if}
</header>

<style>
  .shead {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    background: var(--surface);
  }
  .back {
    width: 30px;
    height: 30px;
    flex: none;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    text-decoration: none;
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .back:hover {
    background: var(--bg-muted);
    color: var(--text);
  }
  .back:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .mid {
    flex: 1;
    min-width: 0;
  }
  .ttl {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path {
    margin: 2px 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dev {
    color: var(--text-secondary);
  }
  .ctrls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }

  @media (max-width: 640px) {
    .shead {
      padding: var(--space-3) var(--space-4);
    }
    .path {
      display: none;
    }
    .ctrls {
      display: none;
    }
  }
</style>
