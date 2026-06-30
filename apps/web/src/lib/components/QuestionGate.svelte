<script lang="ts">
  import type { QuestionAnswerItem } from '@telecode/protocol';
  import { Button } from '@telecode/ui';

  import type { TranscriptEntry } from '$lib/session';

  /**
   * The adopted-session question card (enterprise-ui §7, Journey 2). An externally-started Claude Code
   * session raised a multiple-choice `AskUserQuestion`; the operator answers it from here and the daemon
   * relays the pick back to the model as deny-feedback. This is **best-effort** (AD-4) — honestly labelled
   * as such, never dressed up as a guaranteed answer. Verification-gated like the permission gate: once
   * submitted it shows "Sending…" and only resolves to "sent" on the daemon's next frame. "Other" is always
   * available (Claude Code sends no flag), so every question offers a free-text fallback.
   */
  type QuestionEntry = Extract<TranscriptEntry, { kind: 'question' }>;

  let {
    entry,
    onanswer,
  }: { entry: QuestionEntry; onanswer: (answers: QuestionAnswerItem[]) => void } = $props();

  /** One working answer per question: the chosen option label(s) plus the always-available free text. */
  type Draft = { selected: string[]; otherOn: boolean; otherText: string };
  // Seed once from the (id-keyed, stable) entry; the operator then edits this local copy independently.
  function emptyDrafts(): Draft[] {
    return entry.questions.map(() => ({ selected: [], otherOn: false, otherText: '' }));
  }
  let drafts = $state<Draft[]>(emptyDrafts());
  let error = $state('');

  const isPending = $derived(entry.answer === 'pending');
  const isAnswering = $derived(entry.answer === 'answering');

  function pickRadio(qi: number, label: string): void {
    drafts[qi] = { selected: [label], otherOn: false, otherText: drafts[qi]!.otherText };
    error = '';
  }
  function pickOtherRadio(qi: number): void {
    drafts[qi] = { selected: [], otherOn: true, otherText: drafts[qi]!.otherText };
    error = '';
  }
  function toggleCheckbox(qi: number, label: string): void {
    const d = drafts[qi]!;
    d.selected = d.selected.includes(label)
      ? d.selected.filter((l) => l !== label)
      : [...d.selected, label];
    error = '';
  }
  function toggleOther(qi: number): void {
    drafts[qi]!.otherOn = !drafts[qi]!.otherOn;
    error = '';
  }

  /** Build the wire answers, or null if any question is still unanswered (no selection and no "Other"). */
  function buildAnswers(): QuestionAnswerItem[] | null {
    const answers: QuestionAnswerItem[] = [];
    for (const d of drafts) {
      const other = d.otherText.trim();
      const hasOther = d.otherOn && other.length > 0;
      if (d.selected.length === 0 && !hasOther) return null;
      answers.push({ selectedLabels: d.selected, ...(hasOther ? { otherText: other } : {}) });
    }
    return answers;
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const answers = buildAnswers();
    if (!answers) {
      error = 'Choose an option (or fill in “Other”) for each question before sending.';
      return;
    }
    onanswer(answers);
  }

  /** How a recorded answer reads back (answered/replayed state): selected labels then any free text. */
  function answerText(answer: QuestionAnswerItem | undefined): string {
    if (!answer) return '—';
    const parts = [...answer.selectedLabels, ...(answer.otherText ? [answer.otherText] : [])];
    return parts.length > 0 ? parts.join(', ') : '—';
  }
</script>

<section class="gate" data-state={entry.answer} aria-label="Question from the agent">
  <header class="head">
    <span class="eyebrow">{isPending ? 'AWAITING INPUT' : 'QUESTION'}</span>
    <span class="tag" title="The agent receives your pick as relayed feedback — it usually proceeds.">
      best-effort
    </span>
  </header>

  {#if isPending}
    <form class="form" onsubmit={submit}>
      {#each entry.questions as question, qi (qi)}
        <fieldset class="q">
          <legend class="q-title">{question.question}</legend>
          <div class="options" role={question.multiSelect ? 'group' : 'radiogroup'}>
            {#each question.options as option, oi (oi)}
              <label class="option">
                {#if question.multiSelect}
                  <input
                    type="checkbox"
                    checked={drafts[qi]?.selected.includes(option.label)}
                    onchange={() => toggleCheckbox(qi, option.label)}
                  />
                {:else}
                  <input
                    type="radio"
                    name={`q-${entry.id}-${qi}`}
                    checked={drafts[qi]?.selected[0] === option.label}
                    onchange={() => pickRadio(qi, option.label)}
                  />
                {/if}
                <span class="option-body">
                  <span class="option-label">{option.label}</span>
                  {#if option.description}
                    <span class="option-desc">{option.description}</span>
                  {/if}
                </span>
              </label>
            {/each}

            <!-- "Other" is always offered (Claude Code sends no flag) — a free-text fallback. -->
            <label class="option">
              {#if question.multiSelect}
                <input
                  type="checkbox"
                  checked={drafts[qi]?.otherOn}
                  onchange={() => toggleOther(qi)}
                />
              {:else}
                <input
                  type="radio"
                  name={`q-${entry.id}-${qi}`}
                  checked={drafts[qi]?.otherOn}
                  onchange={() => pickOtherRadio(qi)}
                />
              {/if}
              <span class="option-body"><span class="option-label">Other…</span></span>
            </label>

            {#if drafts[qi]?.otherOn}
              <input
                class="other-input"
                type="text"
                bind:value={drafts[qi]!.otherText}
                aria-label={`Your own answer for: ${question.question}`}
                placeholder="Type your answer…"
              />
            {/if}
          </div>
        </fieldset>
      {/each}

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <div class="actions">
        <Button variant="primary" type="submit">Send answer</Button>
        <span class="note">Relayed to the agent as feedback — best-effort, not a guaranteed answer.</span>
      </div>
    </form>
  {:else if isAnswering}
    <p class="status-line" role="status">
      <span class="spinner" aria-hidden="true"></span>
      Sending…
    </p>
  {:else if entry.answer === 'answered'}
    <div class="resolved">
      <ul class="answers">
        {#each entry.questions as question, qi (qi)}
          <li>
            <span class="a-q">{question.header}</span>
            <span class="a-v">{answerText(entry.answers?.[qi])}</span>
          </li>
        {/each}
      </ul>
      <p class="sent">Answer sent · best-effort</p>
    </div>
  {:else}
    <!-- closed: the session ended before this was answered; telecode could not relay it. -->
    <p class="closed">Question closed — the session ended before you answered.</p>
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
  /* Pending = the one place amber earns emphasis: a left accent rail + tinted surface (the scalpel). */
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
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .q {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .q-title {
    padding: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .option {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .option:hover {
    background: var(--bg-muted);
  }
  .option input {
    margin: 0;
    margin-top: 2px;
    width: 16px;
    height: 16px;
    flex: none;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .option input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
    border-radius: var(--radius-sm);
  }
  .option-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .option-label {
    font-size: var(--text-sm);
    color: var(--text);
  }
  .option-desc {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    line-height: var(--lh-xs);
  }
  .other-input {
    margin-top: var(--space-1);
    /* 1rem (16px) so iOS Safari does not auto-zoom the field on focus. */
    font-size: 1rem;
    font-family: var(--font-sans);
    color: var(--text);
    background: var(--bg-subtle);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
  }
  .other-input:focus-visible {
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
  .answers {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .answers li {
    display: flex;
    gap: var(--space-3);
    align-items: baseline;
    flex-wrap: wrap;
  }
  .a-q {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .a-v {
    font-size: var(--text-sm);
    color: var(--text);
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
