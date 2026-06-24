<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
  type Size = 'sm' | 'md' | 'lg';

  type Props = HTMLButtonAttributes & {
    variant?: Variant;
    size?: Size;
    /** Show a spinner and block interaction while an action is in flight. */
    loading?: boolean;
    children: Snippet;
  };

  let {
    variant = 'secondary',
    size = 'md',
    loading = false,
    disabled = false,
    type = 'button',
    children,
    ...rest
  }: Props = $props();
</script>

<button
  class="btn {variant} {size}"
  {type}
  disabled={disabled || loading}
  aria-busy={loading}
  {...rest}
>
  {#if loading}<span class="spinner" aria-hidden="true"></span>{/if}
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    font-family: var(--font-sans);
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .btn:focus-visible {
    outline: none;
    /* Ring as box-shadow (respects border-radius); offset gap in the page bg. */
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Sizes — dense control surface; min 32px target height. */
  .sm {
    height: 28px;
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
  }
  .md {
    height: 32px;
    padding: 0 var(--space-4);
    font-size: var(--text-sm);
  }
  .lg {
    height: 40px;
    padding: 0 var(--space-5);
    font-size: var(--text-sm);
  }

  /* The amber accent earns its one solid fill on the primary action. */
  .primary {
    background: var(--primary);
    color: var(--primary-text);
  }
  .primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .primary:active:not(:disabled) {
    background: var(--accent-press);
  }

  .secondary {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .secondary:hover:not(:disabled) {
    background: var(--bg-muted);
  }

  .ghost {
    background: transparent;
    color: var(--text);
  }
  .ghost:hover:not(:disabled) {
    background: var(--bg-muted);
  }

  .danger {
    background: var(--danger);
    color: #fff;
  }
  .danger:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid currentcolor;
    border-right-color: transparent;
    border-radius: var(--radius-full);
    animation: spin 0.6s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
    .btn {
      transition: none;
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
