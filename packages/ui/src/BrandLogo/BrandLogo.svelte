<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  /**
   * The telecode brand lockup: the signature amber "prompt-signal" mark (a chevron with two signal
   * arcs) rendered INLINE so it inherits crisp vector scaling and the `--accent` token, paired with
   * the "telecode" wordmark in Geist Mono. Inline rather than an `<img>` so it stays theme-aware and
   * needs no font round-trip (the shipped horizontal-logo SVG pulls Geist Mono over the network).
   *
   * `size` is the mark's edge in px; the wordmark scales from it. `showWordmark={false}` renders the
   * mark alone — when used that way, give the parent an accessible name (e.g. an `aria-label` on the
   * wrapping link), since the mark itself is decorative.
   */
  type Props = HTMLAttributes<HTMLSpanElement> & {
    size?: number;
    showWordmark?: boolean;
  };

  let { size = 20, showWordmark = true, ...rest }: Props = $props();
</script>

<span class="logo" style="--mark: {size}px" {...rest}>
  <svg
    class="mark"
    viewBox="0 0 64 64"
    width={size}
    height={size}
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <polyline
      points="18,17 33,32 18,47"
      stroke="var(--accent)"
      stroke-width="5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M37.8,25.6 A8,8 0 0 1 37.8,38.4"
      stroke="var(--accent)"
      stroke-width="2.6"
      stroke-linecap="round"
      opacity="0.85"
    />
    <path
      d="M40.8,21.6 A13,13 0 0 1 40.8,42.4"
      stroke="var(--accent)"
      stroke-width="2.6"
      stroke-linecap="round"
      opacity="0.5"
    />
  </svg>
  {#if showWordmark}
    <span class="wordmark"><span>tele</span><span class="accent">code</span></span>
  {/if}
</span>

<style>
  .logo {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    line-height: 1;
  }
  .mark {
    flex: none;
    display: block;
  }
  .wordmark {
    font-family: var(--font-mono);
    font-weight: 500;
    font-size: calc(var(--mark) * 0.82);
    letter-spacing: 0.01em;
    color: var(--text);
    white-space: nowrap;
  }
  .wordmark .accent {
    color: var(--accent);
  }
</style>
