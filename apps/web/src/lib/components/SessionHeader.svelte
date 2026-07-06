<script lang="ts">
  import { Button, Pill, type PillTone } from '@telecode/ui';

  import SessionTitleEditor from '$lib/components/SessionTitleEditor.svelte';
  import { SESSION_DISPLAY } from '$lib/session-display';
  import type { SessionStatus } from '$lib/session';
  import type { SessionActionResult } from '$lib/session-store';

  /**
   * The session-view header (enterprise-ui §7): a back link to the list, the session title (with inline
   * rename, ux Phase 6 T6) + the machine it runs on, the live status pill, and the operator controls
   * (Interrupt / End). Controls are disabled off a live channel and never optimistic — the daemon reports
   * the resulting status. Only real metadata is shown (the device + short id; no invented path).
   */
  let {
    title,
    deviceName,
    cwd = null,
    sessionId,
    status,
    isBusy,
    isTerminal,
    showControls,
    connected,
    canReset,
    canHousekeep = false,
    houseBusy = false,
    onrename,
    onreset,
    oninterrupt,
    onend,
    onarchive,
    ondelete,
  }: {
    title: string;
    deviceName: string | null;
    /** The session's working directory (from its sealed metadata) — provenance in the header line. */
    cwd?: string | null;
    sessionId: string;
    status: SessionStatus;
    isBusy: boolean;
    isTerminal: boolean;
    showControls: boolean;
    connected: boolean;
    /** Whether a user rename override exists (offer "Reset to default"). */
    canReset: boolean;
    /** Whether the session is ENDED and persisted — Archive/Delete appear only then (T7). */
    canHousekeep?: boolean;
    /** True while an archive is in flight — shows the pending label and blocks a double-fire. */
    houseBusy?: boolean;
    onrename: (title: string) => Promise<SessionActionResult>;
    onreset: () => Promise<SessionActionResult>;
    oninterrupt: () => void;
    onend: () => void;
    onarchive?: () => void;
    ondelete?: () => void;
  } = $props();

  const display = $derived(SESSION_DISPLAY[status]);
  const tone = $derived<PillTone>(display.tone === 'muted' ? 'neutral' : display.tone);
</script>

<header class="shead hairline-b">
  <a class="back" href="/" aria-label="Back to sessions">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </a>

  <div class="mid">
    <SessionTitleEditor {title} {canReset} {onrename} {onreset} />
    <p class="path mono">
      {#if deviceName}<span class="dev">{deviceName}</span> · {/if}
      {#if cwd}<span class="cwd" title={cwd}>{cwd}</span> · {/if}
      <span class="sid">{sessionId.slice(0, 12)}</span>
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

  {#if canHousekeep && onarchive && ondelete}
    <!-- Housekeeping for an ENDED session (T7): shelve it out of the board, or remove it for good.
         Not media-hidden like .ctrls — on a phone these ARE the reason to open a finished session. -->
    <div class="house">
      <Button variant="ghost" size="sm" disabled={houseBusy} onclick={onarchive}>
        {houseBusy ? 'Archiving…' : 'Archive'}
      </Button>
      <Button variant="danger" size="sm" disabled={houseBusy} onclick={ondelete}>Delete</Button>
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
  /* The cwd shares the device's tone; capped so a deep path can't push the session id out of view. */
  .cwd {
    color: var(--text-secondary);
    display: inline-block;
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
  .ctrls,
  .house {
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
