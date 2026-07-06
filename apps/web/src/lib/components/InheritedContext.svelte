<script lang="ts">
  import type { QuestionAnswerItem } from '@telecode/protocol';

  import type { TranscriptEntry } from '$lib/session';

  import TranscriptEntryView from './TranscriptEntryView.svelte';

  /**
   * The earlier segment's transcript, inlined COLLAPSED above the takeover divider (ux Phase 3, B2):
   * "N earlier entries from the terminal segment — show". A native `<details>` disclosure (keyboard
   * free), matching ToolEntry's pattern; expanding reveals the inherited entries rendered by the same
   * shared entry renderer as the live stream — one scrollable story, the fork is a moment not a page.
   * Actions on inherited entries (a still-pending gate) route to the SEGMENT's own session.
   */
  let {
    entries,
    segmentName,
    onapprove,
    onreject,
    onanswer,
    onhandover,
  }: {
    entries: readonly TranscriptEntry[];
    /** Where the inherited stretch ran, in product vocabulary ("terminal" / "telecode"). */
    segmentName: string;
    onapprove: (requestId: string) => void;
    onreject: (requestId: string, message?: string) => void;
    onanswer: (requestId: string, answers: QuestionAnswerItem[]) => void;
    onhandover: (requestId: string, answerText: string) => void;
  } = $props();
</script>

<details class="inherited">
  <summary class="summary mono">
    <svg
      class="chev"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 2l4 3-4 3"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    {entries.length} earlier {entries.length === 1 ? 'entry' : 'entries'} from the {segmentName} segment
  </summary>
  <div class="body">
    {#each entries as entry (entry.id)}
      <div class="entry">
        <TranscriptEntryView {entry} {onapprove} {onreject} {onanswer} {onhandover} />
      </div>
    {/each}
  </div>
</details>

<style>
  .inherited {
    margin: 0;
  }
  .summary {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
    list-style: none;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    padding: var(--space-1) 0;
    border-radius: var(--radius-sm);
    -webkit-tap-highlight-color: transparent;
  }
  .summary::-webkit-details-marker {
    display: none;
  }
  .summary:hover {
    color: var(--text);
  }
  .summary:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
  }
  .chev {
    flex: none;
    transition: transform var(--dur-fast) var(--ease);
  }
  details[open] .chev {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-3) 0 var(--space-2);
  }
</style>
