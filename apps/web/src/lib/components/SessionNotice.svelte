<script lang="ts">
  /**
   * A non-blocking "needs attention" banner for an adopted session (enterprise-ui, Journey 3). It surfaces
   * Claude Code's own `Notification` text (e.g. the session went idle waiting for input) — a soft cue, not a
   * gate, so it is dismissible and uses the amber accent as a scalpel (the "awaiting input" signal colour).
   * The reducer clears the notice the moment the session next moves, so this is inherently transient.
   */
  let { message, ondismiss }: { message: string; ondismiss: () => void } = $props();
</script>

<div class="notice" role="status">
  <span class="dot" aria-hidden="true"></span>
  <p class="msg">{message}</p>
  <button class="dismiss" type="button" onclick={ondismiss} aria-label="Dismiss this notice">
    <span aria-hidden="true">×</span>
  </button>
</div>

<style>
  .notice {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--border);
    border-left: 2px solid var(--accent);
  }
  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--accent);
  }
  .msg {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text);
    word-break: break-word;
  }
  .dismiss {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--text-lg);
    line-height: 1;
    border-radius: var(--radius-sm);
  }
  .dismiss:hover {
    color: var(--text);
  }
  .dismiss:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
  }
</style>
