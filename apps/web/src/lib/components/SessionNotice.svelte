<script lang="ts">
  /**
   * A non-blocking banner for a session (enterprise-ui). `attention` (default) surfaces Claude Code's
   * own `Notification` text (e.g. the session went idle) in the amber "awaiting input" signal colour;
   * `danger` surfaces a failure the user must know about (e.g. an undelivered action). A soft cue, not a
   * gate — dismissible, and the reducer clears it the moment the session next moves.
   */
  let {
    message,
    tone = 'attention',
    ondismiss,
  }: { message: string; tone?: 'attention' | 'danger'; ondismiss: () => void } = $props();
</script>

<div class="notice" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
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
  .notice[data-tone='danger'] {
    background: var(--danger-soft);
    border-left-color: var(--danger);
  }
  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--accent);
  }
  .notice[data-tone='danger'] .dot {
    background: var(--danger);
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
