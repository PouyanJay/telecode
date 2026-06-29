<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  import type { PillTone } from './types';

  /**
   * A bordered, pill-shaped label in monospace — the house "tag" for a session's current status, an
   * inline marker like "PERMISSION REQUIRED", or a version chip. The accent tone is the scalpel
   * (enterprise-ui §2): it tints the border + text amber for the one "awaiting / act now" signal, with an
   * optional `dot` (pulsing on live states). Every other tone stays neutral hairline. State is never
   * conveyed by color alone — the `label` always carries the meaning.
   */
  type Props = HTMLAttributes<HTMLSpanElement> & {
    label: string;
    tone?: PillTone;
    dot?: boolean;
    pulse?: boolean;
  };

  let { label, tone = 'neutral', dot = false, pulse = false, ...rest }: Props = $props();
</script>

<span class="pill" data-tone={tone} {...rest}>
  {#if dot}<span class="dot" class:pulse aria-hidden="true"></span>{/if}
  <span class="label">{label}</span>
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 3px var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: transparent;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1;
    letter-spacing: 0.04em;
    white-space: nowrap;
    color: var(--text-secondary);
  }
  .label {
    white-space: nowrap;
  }
  .dot {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: var(--radius-full);
    background: currentcolor;
  }

  [data-tone='accent'] {
    color: var(--accent);
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }
  [data-tone='success'] {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 45%, transparent);
  }
  [data-tone='warning'] {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 45%, transparent);
  }
  [data-tone='danger'] {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
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
