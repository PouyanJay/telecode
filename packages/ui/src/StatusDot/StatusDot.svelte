<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  /**
   * The house status convention (enterprise-ui §status): a small colored dot followed by an
   * UPPERCASE monospace label in neutral text — never a saturated filled pill. The label always
   * carries the meaning, so state is never conveyed by color alone. `pulse` adds a live heartbeat
   * for the one running/awaiting signal (disabled under reduced-motion).
   */
  type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'muted';

  type Props = HTMLAttributes<HTMLSpanElement> & {
    tone?: Tone;
    label: string;
    pulse?: boolean;
  };

  let { tone = 'muted', label, pulse = false, ...rest }: Props = $props();
</script>

<span class="status" data-tone={tone} {...rest}>
  <span class="dot" class:pulse aria-hidden="true"></span>
  <span class="label">{label}</span>
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.06em;
    color: var(--text-secondary);
  }
  .label {
    text-transform: uppercase;
    white-space: nowrap;
  }
  .dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--text-muted);
  }
  [data-tone='accent'] .dot {
    background: var(--accent);
  }
  [data-tone='success'] .dot {
    background: var(--success);
  }
  [data-tone='warning'] .dot {
    background: var(--warning);
  }
  [data-tone='danger'] .dot {
    background: var(--danger);
  }
  .dot.pulse {
    animation: pulse 1.6s var(--ease) infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.pulse {
      animation: none;
    }
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
</style>
