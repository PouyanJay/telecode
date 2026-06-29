<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  /**
   * A welded panel (enterprise-ui §1): one bordered ink region with a hairline-divided header, the
   * structural unit for the Devices and Settings surfaces and the session rail. Compose with hairline
   * rows inside rather than nesting more bordered cards — one border level per region. `title` + `meta`
   * render the default header; pass a `header` snippet to fully customize it. Body content flows via
   * `children` with no inner padding, so callers choose full-bleed rows or a padded form.
   */
  type Props = HTMLAttributes<HTMLElement> & {
    title?: string;
    meta?: string;
    header?: Snippet;
    children: Snippet;
  };

  let { title, meta, header, children, ...rest }: Props = $props();
</script>

<section class="panel" {...rest}>
  {#if header}
    {@render header()}
  {:else if title}
    <header class="phead hairline-b">
      <h2 class="title">{title}</h2>
      {#if meta}<span class="meta">{meta}</span>{/if}
    </header>
  {/if}
  {@render children()}
</section>

<style>
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .phead {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
  }
  .title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .meta {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
