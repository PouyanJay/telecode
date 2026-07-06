<script lang="ts">
  import type { QuestionAnswerItem } from '@telecode/protocol';
  import type { Snippet } from 'svelte';

  import type { TranscriptEntry } from '$lib/session';

  import TranscriptEntryView from './TranscriptEntryView.svelte';

  /**
   * The session stream (enterprise-ui §7): an append-only transcript of agent messages, tool calls,
   * permission gates, and adopted-session questions, each rendered by the shared entry renderer.
   * Auto-scrolls to the newest line while the operator is pinned to the bottom, and releases the
   * moment they scroll up to read history. `lead`/`tail` inline chained-segment context (ux Phase 3):
   * the collapsed inherited transcript + takeover divider above, the "continued in" pointer below —
   * one scrollable story.
   */
  let {
    entries,
    offline = false,
    onapprove,
    onreject,
    onanswer,
    onhandover,
    lead,
    tail,
  }: {
    entries: readonly TranscriptEntry[];
    /** The device is offline — degrades a pending free-form handover to its "answer at your device" state. */
    offline?: boolean;
    onapprove: (requestId: string) => void;
    onreject: (requestId: string, message?: string) => void;
    onanswer: (requestId: string, answers: QuestionAnswerItem[]) => void;
    onhandover: (requestId: string, answerText: string) => void;
    /** Rendered above the entries, inside the scroll (inherited segment + takeover divider). */
    lead?: Snippet;
    /** Rendered below the entries, inside the scroll ("Continued in → open segment" pointer). */
    tail?: Snippet;
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
  {@render lead?.()}
  {#each entries as entry (entry.id)}
    <div class="entry">
      <TranscriptEntryView {entry} {offline} {onapprove} {onreject} {onanswer} {onhandover} />
    </div>
  {/each}
  {@render tail?.()}
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
