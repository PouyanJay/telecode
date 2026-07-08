<script lang="ts">
  /**
   * A non-blocking banner for a session (enterprise-ui). `attention` (default) surfaces Claude Code's
   * own `Notification` text (e.g. the session went idle) in the amber "awaiting input" signal colour;
   * `danger` surfaces a failure the user must know about (e.g. an undelivered action); `warning`
   * surfaces a standing state (e.g. a turn-limited run awaiting continuation); `neutral` carries calm
   * standing guidance (e.g. what sending will do for a between-turns adopted session) — deliberately
   * un-amber: it explains, it doesn't summon. A soft cue, not a gate. With `ondismiss` the banner is
   * dismissible (the reducer clears it when the session next moves); without it the banner STANDS —
   * for notices tied to a state rather than a moment.
   */
  let {
    message,
    tone = 'attention',
    ondismiss,
  }: {
    message: string;
    tone?: 'attention' | 'danger' | 'warning' | 'neutral';
    ondismiss?: () => void;
  } = $props();
</script>

<div class="notice" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
  <span class="dot" aria-hidden="true"></span>
  <p class="msg">{message}</p>
  {#if ondismiss}
    <button class="dismiss" type="button" onclick={ondismiss} aria-label="Dismiss this notice">
      <span aria-hidden="true">×</span>
    </button>
  {/if}
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
  .notice[data-tone='warning'] {
    background: var(--warning-soft);
    border-left-color: var(--warning);
  }
  .notice[data-tone='neutral'] {
    background: var(--bg-subtle);
    border-left-color: var(--border-strong);
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
  .notice[data-tone='warning'] .dot {
    background: var(--warning);
  }
  .notice[data-tone='neutral'] .dot {
    background: var(--text-muted);
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
