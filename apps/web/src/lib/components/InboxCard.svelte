<script lang="ts">
  import { Button, Spinner } from '@telecode/ui';

  import type { InboxAsk } from '$lib/inbox';
  import { summarizeTool } from '$lib/tool-summary';

  import DiffStatBadge from './DiffStatBadge.svelte';
  import { waitingLabel } from '$lib/waiting-label';

  import RejectNoteForm from './RejectNoteForm.svelte';

  /**
   * One pending ask in the needs-you inbox (enterprise-ui §7): the operator can settle an approval
   * without opening the session — tool + one-line input summary + Approve / Reject / Reject with note.
   * Questions and handovers name themselves and link into the session, where their richer pickers
   * live. The waited-longest timer is the urgency signal; amber stays the "act now" scalpel.
   */
  let {
    ask,
    now,
    onapprove,
    onreject,
  }: {
    ask: InboxAsk;
    /** The ticking clock for the waiting pill (owned by the page so all cards agree). */
    now: number;
    onapprove: (sessionId: string, requestId: string) => void;
    onreject: (sessionId: string, requestId: string, message?: string) => void;
  } = $props();

  const EYEBROWS = {
    permission: 'APPROVAL NEEDED',
    question: 'QUESTION FOR YOU',
    handover: 'READY TO TAKE OVER',
  } as const;

  const waiting = $derived(waitingLabel(ask.askedAt, now));
  const isInFlight = $derived(
    ask.kind === 'permission' && (ask.decision === 'approving' || ask.decision === 'rejecting'),
  );

  // Deny-with-note: whether the shared note reveal is open (same interaction as the in-session gate).
  let isNoting = $state(false);
</script>

<article class="ask" aria-label={EYEBROWS[ask.kind]}>
  <header class="head">
    <span class="dot" aria-hidden="true"></span>
    <span class="eyebrow">{EYEBROWS[ask.kind]}</span>
    <a class="session mono" href="/sessions/{ask.sessionId}">
      {ask.sessionTitle ?? ask.sessionId.slice(0, 12)}
    </a>
    {#if ask.deviceName}<span class="device mono">· {ask.deviceName}</span>{/if}
    {#if waiting}<span class="waiting mono" aria-live="off">{waiting}</span>{/if}
  </header>

  {#if ask.kind === 'permission'}
    <p class="summary mono">
      <span class="tool">{ask.toolName}</span>
      {summarizeTool(ask.toolName, ask.input)}
      {#if ask.diffStat}<DiffStatBadge stat={ask.diffStat} />{/if}
    </p>
    {#if isInFlight}
      <p class="status-line" role="status">
        <Spinner />
        {ask.decision === 'approving' ? 'Approving…' : 'Rejecting…'}
      </p>
    {:else if isNoting}
      <RejectNoteForm
        onsubmit={(message) => {
          onreject(ask.sessionId, ask.requestId, message);
          isNoting = false;
        }}
        oncancel={() => (isNoting = false)}
      />
    {:else}
      <div class="actions">
        <Button variant="primary" size="sm" onclick={() => onapprove(ask.sessionId, ask.requestId)}>
          Approve
        </Button>
        <Button variant="secondary" size="sm" onclick={() => onreject(ask.sessionId, ask.requestId)}>
          Reject
        </Button>
        <Button variant="ghost" size="sm" onclick={() => (isNoting = true)}>Reject with note…</Button>
        <a class="open" href="/sessions/{ask.sessionId}">Open session →</a>
      </div>
    {/if}
  {:else}
    <p class="summary">{ask.kind === 'question' ? ask.prompt : ask.question}</p>
    <div class="actions">
      <a class="open" href="/sessions/{ask.sessionId}">
        {ask.kind === 'question' ? 'Answer in the session →' : 'Review & take over →'}
      </a>
    </div>
  {/if}
</article>

<style>
  .ask {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-left: 2px solid var(--accent);
    background: var(--accent-soft);
    border-radius: var(--radius-md);
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
    min-width: 0;
  }
  .dot {
    width: 7px;
    height: 7px;
    flex: none;
    align-self: center;
    border-radius: var(--radius-full);
    background: var(--accent);
    animation: pulse 1.6s var(--ease) infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--accent);
    white-space: nowrap;
  }
  .session {
    font-size: var(--text-xs);
    color: var(--text);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 24rem;
    border-radius: var(--radius-sm);
  }
  .session:hover {
    text-decoration: underline;
  }
  .session:focus-visible,
  .open:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .device {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .waiting {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--accent);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .summary {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text);
    word-break: break-word;
  }
  .summary.mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .tool {
    color: var(--text);
    font-weight: 500;
    margin-right: var(--space-2);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .open {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .open:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .status-line {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
</style>
