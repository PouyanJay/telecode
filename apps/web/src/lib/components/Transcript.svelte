<script lang="ts">
  import type { TranscriptEntry } from '$lib/session';

  import MessageBody from './MessageBody.svelte';
  import PermissionGate from './PermissionGate.svelte';
  import ToolEntry from './ToolEntry.svelte';

  /**
   * The session stream (enterprise-ui §7): an append-only transcript of agent messages, tool calls, and
   * permission gates. Machine data (tool names + inputs) is monospace; agent prose is sans for reading.
   * Auto-scrolls to the newest line while the operator is pinned to the bottom, and releases the moment
   * they scroll up to read history.
   */
  let {
    entries,
    onapprove,
    onreject,
  }: {
    entries: readonly TranscriptEntry[];
    onapprove: (requestId: string) => void;
    onreject: (requestId: string) => void;
  } = $props();

  let listEl = $state<HTMLDivElement>();
  let isPinned = $state(true);

  function onscroll(): void {
    if (!listEl) return;
    isPinned = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 48;
  }

  $effect(() => {
    entries.length; // re-run when a line is appended
    if (isPinned && listEl) listEl.scrollTop = listEl.scrollHeight;
  });
</script>

<!-- A scrollable transcript must be keyboard-reachable so non-mouse users can scroll history (WCAG
     2.1.1); the focus ring makes that visible. The role is `log`, hence the intentional ignore. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="transcript"
  bind:this={listEl}
  onscroll={onscroll}
  role="log"
  aria-live="polite"
  aria-label="Session transcript"
  tabindex="0"
>
  {#each entries as entry (entry.id)}
    <div class="entry">
      {#if entry.kind === 'user'}
        <div class="from-user">
          <p class="who">YOU</p>
          <div class="message"><MessageBody text={entry.text} /></div>
        </div>
      {:else if entry.kind === 'message'}
        <p class="who">AGENT</p>
        <div class="message"><MessageBody text={entry.text} /></div>
      {:else if entry.kind === 'tool'}
        <ToolEntry toolName={entry.toolName} input={entry.input} />
      {:else}
        <PermissionGate
          {entry}
          onapprove={() => onapprove(entry.requestId)}
          onreject={() => onreject(entry.requestId)}
        />
      {/if}
    </div>
  {/each}
</div>

<style>
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-5) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .transcript:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
  }
  .entry {
    animation: enter var(--dur) var(--ease);
  }
  /* The human's own messages read as a distinct, quieter rail — the agent's output is the focus. */
  .from-user {
    padding-left: var(--space-3);
    border-left: 2px solid var(--border-strong);
  }
  .from-user .message {
    color: var(--text-secondary);
  }
  .who {
    margin: 0 0 var(--space-1);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  /* A flow container for MessageBody: prose spans own their own pre-wrap, so the container stays
     `normal` and collapses template whitespace (no stray indentation between segments). */
  .message {
    margin: 0;
    max-width: 70ch;
    color: var(--text);
    font-size: var(--text-base);
    line-height: var(--lh-base);
    word-break: break-word;
  }
  @media (prefers-reduced-motion: reduce) {
    .entry {
      animation: none;
    }
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
</style>
