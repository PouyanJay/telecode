<script lang="ts">
  import type { TranscriptEntry } from '$lib/session';

  import PermissionGate from './PermissionGate.svelte';

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
  let pinned = $state(true);

  function onscroll(): void {
    if (!listEl) return;
    pinned = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 48;
  }

  $effect(() => {
    entries.length; // re-run when a line is appended
    if (pinned && listEl) listEl.scrollTop = listEl.scrollHeight;
  });

  function toolInput(input: Record<string, unknown>): string {
    return JSON.stringify(input, null, 2);
  }
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
      {#if entry.kind === 'message'}
        <p class="who">AGENT</p>
        <p class="message">{entry.text}</p>
      {:else if entry.kind === 'tool'}
        <div class="tool">
          <span class="who">TOOL</span>
          <code class="tool-name">{entry.toolName}</code>
          {#if toolInput(entry.input) !== '{}'}
            <details class="tool-input">
              <summary>input</summary>
              <pre><code>{toolInput(entry.input)}</code></pre>
            </details>
          {/if}
        </div>
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
  .who {
    margin: 0 0 var(--space-1);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .message {
    margin: 0;
    max-width: 70ch;
    color: var(--text);
    font-size: var(--text-base);
    line-height: var(--lh-base);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .tool .who {
    margin: 0;
  }
  .tool-name {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .tool-input {
    flex-basis: 100%;
  }
  .tool-input summary {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    cursor: pointer;
  }
  .tool-input summary:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
    border-radius: var(--radius-sm);
  }
  .tool-input pre {
    margin: var(--space-2) 0 0;
    padding: var(--space-3);
    background: var(--bg-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--text-secondary);
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
