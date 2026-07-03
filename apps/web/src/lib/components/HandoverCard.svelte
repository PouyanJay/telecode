<script lang="ts">
  import { Button } from '@telecode/ui';

  import type { TranscriptEntry } from '$lib/session';

  /**
   * The free-form handover card (enterprise-ui §7, Journey 4). An adopted (externally-started) Claude Code
   * session ended its turn asking a **free-form** question — prose, no tool call, so there is no in-place
   * gate to answer through. Rather than a dead "answer at your device" wall, telecode offers to take the
   * conversation over: submitting **starts a new telecode-launched continuation** that resumes the same
   * conversation with your answer (it is not an in-place reply to the terminal session). Verification-gated
   * like the permission/question gates: once submitted it shows "Taking over…" and resolves on the daemon's
   * next frame (the original session then ends — the conversation migrates to the continuation).
   */
  type HandoverEntry = Extract<TranscriptEntry, { kind: 'handover' }>;

  let {
    entry,
    offline = false,
    onanswer,
  }: {
    entry: HandoverEntry;
    /**
     * The device (daemon) is offline, so telecode can't fork-and-resume right now. A pending offer then
     * degrades to the honest "answer at your device" fallback instead of an actionable form that would fail.
     */
    offline?: boolean;
    onanswer: (answerText: string) => void;
  } = $props();

  let draft = $state('');
  let error = $state('');

  const isPending = $derived(entry.state === 'pending');
  const isSubmitting = $derived(entry.state === 'submitting');

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const answerText = draft.trim();
    if (answerText.length === 0) {
      error = 'Type your answer before taking over the conversation.';
      return;
    }
    onanswer(answerText);
  }
</script>

<section class="gate" data-state={entry.state} aria-label="Free-form question from the agent">
  <header class="head">
    <span class="eyebrow">{isPending ? 'AWAITING INPUT' : 'HANDOVER'}</span>
    <span class="tag" title="Answering starts a new telecode-launched session that resumes this conversation.">
      continue here
    </span>
  </header>

  <p class="question">{entry.question}</p>
  {#if entry.summary}
    <p class="summary">{entry.summary}</p>
  {/if}

  {#if isPending && offline}
    <p class="offline" role="status">
      This device is offline, so telecode can’t take over yet. Answer at your device, or wait for it to
      reconnect to continue here.
    </p>
  {:else if isPending}
    <form class="form" onsubmit={submit}>
      <textarea
        class="answer"
        bind:value={draft}
        rows="3"
        aria-label="Your answer to the agent's free-form question"
        placeholder="Type your answer to continue the conversation here…"
      ></textarea>
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
      <div class="actions">
        <Button variant="primary" type="submit">Take over &amp; continue</Button>
        <span class="note">
          Starts a new telecode-launched session that resumes this conversation with your answer.
        </span>
      </div>
    </form>
  {:else if isSubmitting}
    <p class="status-line" role="status">
      <span class="spinner" aria-hidden="true"></span>
      Taking over…
    </p>
  {:else if entry.state === 'submitted'}
    <div class="resolved">
      {#if entry.answerText}
        <p class="answer-readback"><span class="a-q">YOUR ANSWER</span> {entry.answerText}</p>
      {/if}
      <p class="sent">Taken over · continued in a new session</p>
    </div>
  {:else}
    <!-- closed: the session ended before this was taken over. -->
    <p class="closed">Handover closed — the session ended before you took it over.</p>
  {/if}
</section>

<style>
  .gate {
    border: 1px solid var(--border-strong);
    border-left: 2px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* Pending = amber earns emphasis (a left accent rail + tinted surface — the scalpel). */
  .gate[data-state='pending'] {
    border-left-color: var(--accent);
    background: var(--accent-soft);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .gate[data-state='pending'] .eyebrow {
    color: var(--accent);
  }
  .tag {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    padding: 2px var(--space-2);
    white-space: nowrap;
  }
  .question {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
    max-width: 70ch;
  }
  .summary {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    line-height: var(--lh-xs);
    max-width: 70ch;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .answer {
    /* 1rem (16px) so iOS Safari does not auto-zoom the field on focus. */
    font-size: 1rem;
    font-family: var(--font-sans);
    color: var(--text);
    background: var(--bg-subtle);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    resize: vertical;
    min-height: 3lh;
  }
  .answer:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
  }
  .error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--danger);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .note {
    font-size: var(--text-xs);
    color: var(--text-muted);
    max-width: 40ch;
  }
  .status-line {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .resolved {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .answer-readback {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text);
  }
  .a-q {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-right: var(--space-2);
  }
  .sent {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.04em;
    color: var(--success);
  }
  .closed {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .offline {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    max-width: 60ch;
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
