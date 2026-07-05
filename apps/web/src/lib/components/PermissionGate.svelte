<script lang="ts">
  import { Button } from '@telecode/ui';

  import { buildFileDiff } from '$lib/diff';
  import type { TranscriptEntry } from '$lib/session';

  import Code from './Code.svelte';
  import DiffView from './DiffView.svelte';

  /**
   * The human-in-the-loop gate (enterprise-ui §7): the agent has paused on a consequential tool and is
   * waiting for the operator's verdict. The decision is verification-gated — once acted on it shows a
   * real pending state ("Approving…") and only resolves to APPROVED/REJECTED when the daemon's next
   * frame confirms the round-trip. Amber is the scalpel here: the one place it signals "act now".
   */
  type PermissionEntry = Extract<TranscriptEntry, { kind: 'permission' }>;

  let {
    entry,
    onapprove,
    onreject,
  }: {
    entry: PermissionEntry;
    onapprove: () => void;
    /** Reject the tool; `message` (when the operator wrote a note) is relayed to the agent as guidance. */
    onreject: (message?: string) => void;
  } = $props();

  const inputJson = $derived(JSON.stringify(entry.input, null, 2));
  const isInFlight = $derived(entry.decision === 'approving' || entry.decision === 'rejecting');
  // A file-mutating tool shows its proposed change as a diff (the signature human-in-the-loop view);
  // anything else falls back to the raw, monospace input.
  const diff = $derived(buildFileDiff(entry.toolName, entry.input));

  // Deny-with-note: the note reveal is per-gate local state; a plain Reject needs no note.
  let noting = $state(false);
  let note = $state('');

  function rejectWithNote(): void {
    const message = note.trim();
    onreject(message === '' ? undefined : message);
    noting = false;
    note = '';
  }
</script>

<section class="gate" data-state={entry.decision} aria-label="Permission request">
  <header class="head">
    <span class="eyebrow">{entry.decision === 'pending' ? 'AWAITING INPUT' : 'PERMISSION'}</span>
    <code class="name">{entry.toolName}</code>
  </header>

  {#if diff}
    <DiffView {diff} />
  {:else}
    <Code code={inputJson} language="json" />
  {/if}

  {#if entry.decision === 'pending'}
    {#if noting}
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
        <Button variant="primary" onclick={onapprove}>Approve</Button>
        <Button variant="secondary" onclick={() => onreject()}>Reject</Button>
        <Button variant="ghost" onclick={() => (noting = true)}>Reject with note…</Button>
      </div>
    {/if}
  {:else if isInFlight}
    <p class="status-line" role="status">
      <span class="spinner" aria-hidden="true"></span>
      {entry.decision === 'approving' ? 'Approving…' : 'Rejecting…'}
    </p>
  {:else}
    <p class="resolved" data-decision={entry.decision}>
      {entry.decision === 'approved' ? 'APPROVED' : 'REJECTED'}
    </p>
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
  /* Pending = the one place amber earns emphasis: a left accent rail + tinted surface. */
  .gate[data-state='pending'] {
    border-left-color: var(--accent);
    background: var(--accent-soft);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
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
  .name {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
  }
  .actions {
    display: flex;
    gap: var(--space-2);
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
    font-size: var(--text-sm);
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
  .resolved {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.08em;
  }
  .resolved[data-decision='approved'] {
    color: var(--success);
  }
  .resolved[data-decision='rejected'] {
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
