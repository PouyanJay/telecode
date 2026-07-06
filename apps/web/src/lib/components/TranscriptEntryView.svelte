<script lang="ts">
  import type { QuestionAnswerItem } from '@telecode/protocol';

  import type { TranscriptEntry } from '$lib/session';

  import HandoverCard from './HandoverCard.svelte';
  import MessageBody from './MessageBody.svelte';
  import PermissionGate from './PermissionGate.svelte';
  import QuestionGate from './QuestionGate.svelte';
  import ToolEntry from './ToolEntry.svelte';

  /**
   * One transcript entry, rendered by kind — the single renderer shared by the live stream
   * (`Transcript`) and the collapsed inherited segment (`InheritedContext`, ux Phase 3), so every
   * surface shows an entry identically. Machine data (tool names + inputs) is monospace; agent prose
   * is sans for reading.
   */
  let {
    entry,
    offline = false,
    onapprove,
    onreject,
    onanswer,
    onhandover,
  }: {
    entry: TranscriptEntry;
    /** The device is offline — degrades a pending free-form handover to its "answer at your device" state. */
    offline?: boolean;
    onapprove: (requestId: string) => void;
    onreject: (requestId: string, message?: string) => void;
    onanswer: (requestId: string, answers: QuestionAnswerItem[]) => void;
    onhandover: (requestId: string, answerText: string) => void;
  } = $props();
</script>

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
{:else if entry.kind === 'permission'}
  <PermissionGate
    {entry}
    onapprove={() => onapprove(entry.requestId)}
    onreject={(message) => onreject(entry.requestId, message)}
  />
{:else if entry.kind === 'question'}
  <QuestionGate {entry} onanswer={(answers) => onanswer(entry.requestId, answers)} />
{:else}
  <HandoverCard
    {entry}
    {offline}
    onanswer={(answerText) => onhandover(entry.requestId, answerText)}
  />
{/if}

<style>
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
</style>
