<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';

  import { lockBodyScroll, prefersReducedMotion, trapFocus } from '../actions';
  import { IconButton } from '../IconButton';

  /**
   * A modal side panel (enterprise-ui §4/§7): slides in from the right on desktop, up as a bottom sheet on
   * a phone. Focus is trapped while open (`use:trapFocus`) and restored on close; Escape and a backdrop
   * tap dismiss; the page behind is scroll-locked. Transitions are gated on `prefers-reduced-motion` in the
   * directive itself, since Svelte transitions run regardless of the CSS query. `open` is bindable so the
   * parent owns the state; closing also fires `onclose`.
   */
  type Props = {
    open?: boolean;
    title: string;
    onclose?: () => void;
    children: Snippet;
    footer?: Snippet;
  };

  let { open = $bindable(false), title, onclose, children, footer }: Props = $props();

  function close(): void {
    open = false;
    onclose?.();
  }

  // Captured once at mount: Svelte's fly/fade take a static config object, so a reactive MediaQueryList
  // would buy nothing without a custom transition factory. Re-evaluated each time the drawer remounts.
  const reduce = prefersReducedMotion();
  const mobile =
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches === true;
  const slide = reduce ? { duration: 0 } : mobile ? { y: 360, duration: 260 } : { x: 440, duration: 260 };
  const dim = reduce ? { duration: 0 } : { duration: 180 };

  // Lock the page behind the drawer so background scroll doesn't bleed through while it's open.
  $effect(() => (open ? lockBodyScroll() : undefined));
</script>

{#if open}
  <!-- The backdrop is a decorative dismiss target; keyboard users dismiss via Escape or the Close
       button, so it carries no key handler by design. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="ui-backdrop" transition:fade={dim} onclick={close} aria-hidden="true"></div>

  <div
    class="drawer"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    use:trapFocus
    transition:fly={slide}
  >
    <header class="dh hairline-b">
      <h2 class="dtitle">{title}</h2>
      <IconButton label="Close" variant="ghost" size="sm" onclick={close}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </IconButton>
    </header>

    <div class="dbody">{@render children()}</div>

    {#if footer}
      <footer class="df hairline-t">{@render footer()}</footer>
    {/if}
  </div>
{/if}

<svelte:window onkeydown={(event) => open && event.key === 'Escape' && close()} />

<style>
  .drawer {
    position: fixed;
    inset: 0 0 0 auto;
    width: 440px;
    max-width: 92vw;
    z-index: var(--z-modal);
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface-raised);
    border-left: 1px solid var(--border-strong);
    box-shadow: var(--shadow-lg);
  }
  .dh {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
  }
  .dtitle {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .dbody {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-5);
  }
  .df {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
  }

  @media (max-width: 640px) {
    .drawer {
      inset: auto 0 0 0;
      width: auto;
      max-width: none;
      height: 88dvh;
      border-left: none;
      border-top: 1px solid var(--border-strong);
      border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    }
  }
</style>
