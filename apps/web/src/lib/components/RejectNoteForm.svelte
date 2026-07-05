<script lang="ts">
  import { Button } from '@telecode/ui';

  /**
   * The deny-with-note reveal shared by the in-session PermissionGate and the inbox card: a textarea
   * whose note rides the protocol's deny message as guidance to the agent. Cmd/Ctrl+Enter submits,
   * Escape cancels; an empty note submits as a plain rejection.
   */
  let {
    onsubmit,
    oncancel,
  }: { onsubmit: (message?: string) => void; oncancel: () => void } = $props();

  let note = $state('');

  function submit(): void {
    const message = note.trim();
    onsubmit(message === '' ? undefined : message);
  }
</script>

<div class="note-form">
  <!-- svelte-ignore a11y_autofocus — the reveal is the operator's own click; focus follows intent. -->
  <textarea
    class="note-input"
    rows="2"
    placeholder="Tell the agent why, or what to do instead…"
    bind:value={note}
    autofocus
    onkeydown={(e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
      if (e.key === 'Escape') oncancel();
    }}
  ></textarea>
  <div class="actions">
    <Button variant="danger" size="sm" onclick={submit}>Reject with note</Button>
    <Button variant="ghost" size="sm" onclick={oncancel}>Cancel</Button>
  </div>
</div>

<style>
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
    /* Never under 16px: a smaller input makes iOS Safari zoom the page on focus. */
    font-size: max(var(--text-base), 1rem);
    line-height: var(--lh-base);
  }
  .note-input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .actions {
    display: flex;
    gap: var(--space-2);
  }
</style>
