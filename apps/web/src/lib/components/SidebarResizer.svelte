<script lang="ts">
  /**
   * The draggable divider between the sidebar and the content (enterprise-ui §3/§4). A proper
   * `role="separator"` with `aria-orientation` + value range, so it's keyboard-operable (arrows nudge,
   * Shift = bigger step, Home/End jump to the bounds) as well as pointer-draggable; double-click resets.
   * `width` is bindable — the shell owns + persists it. Hidden on the phone, where the bottom nav replaces
   * the sidebar. Listeners are attached via a `use:` action (not inline handlers) so the separator stays a
   * clean ARIA splitter without tripping the no-handlers-on-noninteractive-element lint.
   */
  type Props = {
    width: number;
    min: number;
    max: number;
    onreset?: () => void;
  };

  let { width = $bindable(), min, max, onreset }: Props = $props();

  let dragging = $state(false);

  function clamp(px: number): number {
    return Math.min(max, Math.max(min, Math.round(px)));
  }

  /** Wire pointer-drag + keyboard resize onto the separator node. */
  function resizable(node: HTMLElement) {
    let startX = 0;
    let startWidth = 0;

    function onpointerdown(event: PointerEvent): void {
      dragging = true;
      startX = event.clientX;
      startWidth = width;
      node.setPointerCapture(event.pointerId);
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    }
    function onpointermove(event: PointerEvent): void {
      if (dragging) width = clamp(startWidth + (event.clientX - startX));
    }
    function onpointerup(event: PointerEvent): void {
      if (!dragging) return;
      dragging = false;
      node.releasePointerCapture?.(event.pointerId);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    function onkeydown(event: KeyboardEvent): void {
      const step = event.shiftKey ? 24 : 8;
      if (event.key === 'ArrowLeft') width = clamp(width - step);
      else if (event.key === 'ArrowRight') width = clamp(width + step);
      else if (event.key === 'Home') width = min;
      else if (event.key === 'End') width = max;
      else return;
      event.preventDefault();
    }
    function ondblclick(): void {
      onreset?.();
    }

    node.addEventListener('pointerdown', onpointerdown);
    node.addEventListener('pointermove', onpointermove);
    node.addEventListener('pointerup', onpointerup);
    node.addEventListener('pointercancel', onpointerup);
    node.addEventListener('keydown', onkeydown);
    node.addEventListener('dblclick', ondblclick);
    return {
      destroy(): void {
        node.removeEventListener('pointerdown', onpointerdown);
        node.removeEventListener('pointermove', onpointermove);
        node.removeEventListener('pointerup', onpointerup);
        node.removeEventListener('pointercancel', onpointerup);
        node.removeEventListener('keydown', onkeydown);
        node.removeEventListener('dblclick', ondblclick);
      },
    };
  }
</script>

<!-- A focusable resize `separator` is the WAI-ARIA window-splitter pattern; the linter doesn't treat the
     role as interactive, so the tabindex note is a false positive here. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="resizer"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize sidebar"
  aria-valuenow={width}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  use:resizable
></div>

<style>
  .resizer {
    grid-row: 2;
    grid-column: 1;
    justify-self: end;
    width: 10px;
    margin-right: -5px; /* straddle the sidebar/content divider */
    z-index: 5;
    cursor: col-resize;
    touch-action: none;
    /* A hairline that thickens to the accent on hover / focus / drag. */
    background: linear-gradient(var(--border), var(--border)) center / 1px 100% no-repeat;
    transition: background-size var(--dur-fast) var(--ease);
  }
  .resizer:hover,
  .resizer.dragging,
  .resizer:focus-visible {
    background-image: linear-gradient(var(--accent), var(--accent));
    background-size: 2px 100%;
  }
  .resizer:focus-visible {
    outline: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .resizer {
      transition: none;
    }
  }
  @media (max-width: 640px) {
    .resizer {
      display: none;
    }
  }
</style>
