<script lang="ts">
  import type { SessionOrigin } from '@telecode/protocol';
  import { Button, Pill, type PillTone } from '@telecode/ui';

  import SessionTitleEditor from '$lib/components/SessionTitleEditor.svelte';
  import { sessionControlsFor } from '$lib/session-controls';
  import { SESSION_DISPLAY } from '$lib/session-display';
  import type { SessionStatus } from '$lib/session';
  import type { SessionActionResult } from '$lib/session-store';

  /**
   * The session-view header (enterprise-ui §7): a back link to the list, the session title (with inline
   * rename, ux Phase 6 T6) + the machine it runs on, the live status pill, and the operator controls.
   * Controls are HONEST per origin (adopted-takeover T6): an adopted session gets no Interrupt (there
   * is no telecode-owned turn to abort) and its End reads "Stop following" (it retires the mirror; the
   * local process is untouched). Controls are disabled off a live channel and never optimistic — the
   * daemon reports the resulting status. Only real metadata is shown (the device + short id).
   */
  let {
    title,
    deviceName,
    cwd = null,
    branch = null,
    sessionId,
    status,
    origin = 'launched',
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
    /** The workspace's git branch (sealed meta) — which line of work this session is on. */
    branch?: string | null;
    sessionId: string;
    status: SessionStatus;
    /** Where the session runs: telecode-launched, or adopted from the user's own terminal. */
    origin?: SessionOrigin;
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
  const controls = $derived(sessionControlsFor(origin, isBusy, isTerminal));
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
      {#if branch}<span class="branch" title={branch}>{branch}</span> · {/if}
      <span class="sid">{sessionId.slice(0, 12)}</span>
    </p>
  </div>

  <Pill {tone} dot pulse={display.pulse} label={display.label} aria-live="polite" />

  {#if showControls}
    <div class="ctrls">
      {#if controls.showInterrupt}
        <Button variant="ghost" size="sm" disabled={!connected} onclick={oninterrupt}>
          Interrupt
        </Button>
      {/if}
      {#if controls.showEnd}
        <Button
          variant={controls.endLabel === 'End' ? 'danger' : 'secondary'}
          size="sm"
          disabled={!connected}
          title={controls.endTitle}
          onclick={onend}
        >
          {controls.endLabel}
        </Button>
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
  /* cwd and branch share the device's tone; capped so neither can push the session id out of view. */
  .branch {
    color: var(--text-secondary);
    display: inline-block;
    max-width: 20ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
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
      /* The controls WRAP to a full-width second row (adopted-takeover T7) — hiding them left
         phones with no Interrupt/End/Stop-following at all. Full text labels, same buttons. */
      flex-wrap: wrap;
      row-gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
    }
    .path {
      display: none;
    }
    .ctrls,
    .house {
      flex-basis: 100%;
      justify-content: flex-start;
      /* Second row aligns under the title, past the back button (30px + the flex gap). */
      padding-left: calc(30px + var(--space-3));
    }
  }
</style>
