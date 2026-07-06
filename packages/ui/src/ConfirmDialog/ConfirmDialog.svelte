<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, scale } from 'svelte/transition';

  import { trapFocus } from '../actions';
  import { Button } from '../Button';

  /**
   * A centered confirmation dialog for a single focused, often destructive decision (enterprise-ui
   * §7 — "modals for focused tasks only"). Focus is trapped while open and restored on close; Escape
   * and a backdrop tap dismiss (a destructive action is cancel-by-default, so an accidental dismiss is
   * the safe outcome). Initial focus lands on Cancel, not the destructive button. `title`/`body` +
   * an optional `details` snippet carry the consequence copy; `confirmTone` picks the confirm button's
   * intent. `busy` shows the in-flight state and blocks a double-fire. Transitions are gated on
   * `prefers-reduced-motion` in the directive itself.
   */
  type Props = {
    open?: boolean;
    title: string;
    body?: string;
    confirmLabel: string;
    cancelLabel?: string;
    confirmTone?: 'danger' | 'primary';
    busy?: boolean;
    onconfirm: () => void;
    oncancel?: () => void;
    details?: Snippet;
  };

  let {
    open = $bindable(false),
    title,
    body,
    confirmLabel,
    cancelLabel = 'Cancel',
    confirmTone = 'danger',
    busy = false,
    onconfirm,
    oncancel,
    details,
  }: Props = $props();

  const titleId = `confirm-title-${Math.random().toString(36).slice(2)}`;
  const bodyId = `confirm-body-${Math.random().toString(36).slice(2)}`;

  function cancel(): void {
    if (busy) return; // don't yank a dialog out from under an in-flight action
    open = false;
    oncancel?.();
  }

  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const pop = reduce ? { duration: 0 } : { duration: 180, start: 0.96 };
  const dim = reduce ? { duration: 0 } : { duration: 180 };

  // Lock background scroll while the dialog is open.
  $effect(() => {
    if (!open || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  });
</script>

{#if open}
  <!-- Backdrop dismisses; keyboard users use Escape or the Cancel button, so it carries no key handler. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" transition:fade={dim} onclick={cancel} aria-hidden="true"></div>

  <div class="wrap">
    <div
      class="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      use:trapFocus
      transition:scale={pop}
    >
      <h2 class="title" id={titleId}>{title}</h2>
      {#if body}<p class="body" id={bodyId}>{body}</p>{/if}
      {#if details}<div class="details">{@render details()}</div>{/if}
      <div class="actions">
        <Button variant="ghost" size="md" onclick={cancel} disabled={busy}>{cancelLabel}</Button>
        <Button variant={confirmTone} size="md" loading={busy} onclick={onconfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(event) => open && event.key === 'Escape' && cancel()} />

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-overlay);
    background: rgba(0, 0, 0, 0.55);
  }
  .wrap {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    /* the wrap only positions the dialog — pointer events belong to the dialog + backdrop */
    pointer-events: none;
  }
  .dialog {
    pointer-events: auto;
    width: 26rem;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    background: var(--surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .body {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
  }
  .details {
    font-size: var(--text-sm);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }
  @media (max-width: 480px) {
    .actions {
      flex-direction: column-reverse;
    }
  }
</style>
