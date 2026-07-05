<script lang="ts">
  import { Button } from '@telecode/ui';

  import type { InboxAsk } from '$lib/inbox';
  import { waitingLabel } from '$lib/inbox';
  import { summarizeTool } from '$lib/tool-summary';

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
  const inFlight = $derived(
    ask.kind === 'permission' && (ask.decision === 'approving' || ask.decision === 'rejecting'),
  );

  // Deny-with-note reveal (same interaction as the in-session gate).
  let noting = $state(false);
  let note = $state('');

  function rejectWithNote(): void {
    if (ask.kind !== 'permission') return;
    const message = note.trim();
    onreject(ask.sessionId, ask.requestId, message === '' ? undefined : message);
    noting = false;
    note = '';
  }
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
    </p>
    {#if inFlight}
      <p class="status-line" role="status">
        <span class="spinner" aria-hidden="true"></span>
        {ask.decision === 'approving' ? 'Approving…' : 'Rejecting…'}
      </p>
    {:else if noting}
      <div class="note-form">
        <!-- svelte-ignore a11y_autofocus — the reveal is the operator's own click; focus follows intent. -->
        <textarea
          class="note-input"
          rows="2"
          placeholder="Tell the agent why, or what to do instead…"
          bind:value={note}
          autofocus
          onkeydown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') rejectWithNote();
            if (e.key === 'Escape') (noting = false), (note = '');
          }}
        ></textarea>
        <div class="actions">
          <Button variant="danger" size="sm" onclick={rejectWithNote}>Reject with note</Button>
          <Button variant="ghost" size="sm" onclick={() => ((noting = false), (note = ''))}>
            Cancel
          </Button>
        </div>
      </div>
    {:else}
      <div class="actions">
        <Button variant="primary" size="sm" onclick={() => onapprove(ask.sessionId, ask.requestId)}>
          Approve
        </Button>
        <Button variant="secondary" size="sm" onclick={() => onreject(ask.sessionId, ask.requestId)}>
          Reject
        </Button>
        <Button variant="ghost" size="sm" onclick={() => (noting = true)}>Reject with note…</Button>
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
  .note-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .note-input {
    width: 100%;
    resize: vertical;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--lh-base);
  }
  .note-input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .status-line {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .spinner {
    width: 12px;
    height: 12px;
    flex: none;
    border: 2px solid currentcolor;
    border-right-color: transparent;
    border-radius: var(--radius-full);
    animation: spin 0.6s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
