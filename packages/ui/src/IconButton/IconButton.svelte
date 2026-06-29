<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  /**
   * A square, icon-only control (back, pause, end, drawer-close, send) — the counterpart to {@link Button}
   * for actions that read as a glyph. An accessible `label` is REQUIRED and becomes both `aria-label` and
   * the native tooltip, since an icon carries no text (enterprise-ui §3). The icon rides in via `children`;
   * `danger` tints the hover toward destructive (end session / revoke).
   */
  type Variant = 'outline' | 'ghost' | 'accent';
  type Size = 'sm' | 'md' | 'lg';

  type Props = Omit<HTMLButtonAttributes, 'aria-label'> & {
    label: string;
    variant?: Variant;
    size?: Size;
    danger?: boolean;
    children: Snippet;
  };

  let {
    label,
    variant = 'outline',
    size = 'md',
    danger = false,
    type = 'button',
    children,
    ...rest
  }: Props = $props();
</script>

<button
  class="icon-btn {variant} {size}"
  class:danger
  {type}
  aria-label={label}
  title={label}
  {...rest}
>
  {@render children()}
</button>

<style>
  .icon-btn {
    display: inline-grid;
    place-items: center;
    flex: none;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .icon-btn:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Sizes — dense control surface; ≥28px keeps the AA hit target while staying compact. */
  .sm {
    width: 28px;
    height: 28px;
  }
  .md {
    width: 32px;
    height: 32px;
  }
  .lg {
    width: 44px;
    height: 44px;
  }

  .outline {
    border-color: var(--border);
    background: var(--surface);
  }
  .outline:hover:not(:disabled) {
    background: var(--bg-muted);
    color: var(--text);
    border-color: var(--border-strong);
  }

  .ghost {
    background: transparent;
  }
  .ghost:hover:not(:disabled) {
    background: var(--bg-muted);
    color: var(--text);
  }

  /* The one amber-filled icon control (the mobile launch FAB). */
  .accent {
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .accent:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .icon-btn.danger:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }

  @media (prefers-reduced-motion: reduce) {
    .icon-btn {
      transition: none;
    }
  }
</style>
