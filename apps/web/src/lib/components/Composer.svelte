<script lang="ts">
  import { Button } from '@telecode/ui';

  /**
   * The session composer (enterprise-ui §forms): a prompt box that launches a session or sends a
   * follow-up to steer it (the page chooses, and sets `submitLabel`). The page positions it — centered
   * with the heading when idle, docked at the bottom once a transcript exists. Enter inserts a newline;
   * ⌘/Ctrl+Enter submits (the prompt is free-form, often multi-line). Submit stays enabled until
   * submission starts; while a turn is running the composer is disabled rather than swallowing input.
   */
  let {
    isBusy = false,
    disabledReason,
    submitLabel = 'Launch',
    placeholder = 'Describe a task for the agent…',
    onsend,
  }: {
    isBusy?: boolean;
    disabledReason?: string;
    submitLabel?: string;
    placeholder?: string;
    onsend: (text: string) => void;
  } = $props();

  let prompt = $state('');
  const isBlocked = $derived(isBusy || disabledReason !== undefined);

  function handleSubmit(event: Event): void {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || isBlocked) return;
    onsend(trimmed);
    prompt = '';
  }

  function onkeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      handleSubmit(event);
    }
  }
</script>

<form class="composer" onsubmit={handleSubmit} aria-label="Send to the session">
  <label class="sr-only" for="prompt">Prompt</label>
  <textarea
    id="prompt"
    name="prompt"
    bind:value={prompt}
    onkeydown={onkeydown}
    placeholder={disabledReason ?? placeholder}
    rows="1"
    disabled={disabledReason !== undefined}
    autocomplete="off"
    aria-keyshortcuts="Meta+Enter Control+Enter"
  ></textarea>
  <Button
    type="submit"
    variant="primary"
    size="lg"
    loading={isBusy}
    disabled={isBlocked}
    title="Send (⌘↵)"
  >
    {submitLabel}
  </Button>
</form>

<style>
  /* Flat by design: no surface/border of its own (that read as a "halo"). The textarea carries the
     only input affordance; the page positions and pads the composer (centered when empty, docked when
     a transcript exists). Button (lg, 40px) and a single-row textarea (40px) bottom-align cleanly. */
  .composer {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
  }
  textarea {
    flex: 1;
    min-height: 40px;
    max-height: 160px;
    resize: vertical;
    padding: var(--space-2) var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 16px; /* ≥16px stops iOS Safari zoom-on-focus */
    line-height: var(--lh-base);
  }
  textarea::placeholder {
    color: var(--text-muted);
  }
  textarea:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
