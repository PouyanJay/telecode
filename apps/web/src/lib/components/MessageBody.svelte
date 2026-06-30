<script lang="ts">
  import type { Highlighter } from 'shiki';
  import { onMount } from 'svelte';

  import { browser } from '$app/environment';
  import { renderMarkdown } from '$lib/markdown';
  import { sanitizeMarkdownHtml } from '$lib/sanitize-html';
  import { getMarkdownHighlighter } from '$lib/shiki';

  /**
   * Renders one agent/user message as full markdown (enterprise-ui §7) — headings, emphasis, lists, links,
   * tables, blockquotes — with fenced code highlighted by Shiki, all themed to the design tokens. The pure
   * render lives in `$lib/markdown`; this stays a thin renderer that sanitizes before injecting. The
   * highlighter loads lazily, so prose paints immediately and code upgrades from plain to highlighted once
   * it resolves. Streaming-safe: each message is a complete block (a partial mid-stream renders as-is).
   */
  let { text }: { text: string } = $props();

  let highlighter = $state<Highlighter | null>(null);
  onMount(() => {
    void getMarkdownHighlighter()
      .then((resolved) => {
        highlighter = resolved;
      })
      .catch(() => {
        // Highlighting is progressive enhancement — prose still renders without it.
      });
  });

  // Sanitize at the trust boundary (browser-only; SSR shows plain text since the live transcript is client-side).
  const html = $derived(browser ? sanitizeMarkdownHtml(renderMarkdown(text, highlighter)) : '');
</script>

{#if browser}
  <!-- Sanitized above with DOMPurify (sanitize-html.ts); agent markdown is rendered, not trusted raw. -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  <div class="markdown">{@html html}</div>
{:else}
  <div class="markdown"><p class="fallback">{text}</p></div>
{/if}

<style>
  .fallback {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* The injected markdown isn't Svelte-scoped, so style it via :global under the scoped .markdown wrapper.
     Every value is a design token — the agent's prose reads as part of the instrument, not a web page. */
  .markdown :global(:first-child) {
    margin-top: 0;
  }
  .markdown :global(:last-child) {
    margin-bottom: 0;
  }

  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    margin: var(--space-4) 0 var(--space-2);
    font-weight: 600;
    line-height: var(--lh-lg);
    color: var(--text);
  }
  .markdown :global(h1) {
    font-size: var(--text-xl);
  }
  .markdown :global(h2) {
    font-size: var(--text-lg);
  }
  .markdown :global(h3) {
    font-size: var(--text-base);
  }
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .markdown :global(p) {
    margin: var(--space-3) 0;
  }

  .markdown :global(strong) {
    font-weight: 600;
    color: var(--text);
  }
  .markdown :global(em) {
    font-style: italic;
  }
  .markdown :global(del) {
    color: var(--text-muted);
  }

  .markdown :global(ul),
  .markdown :global(ol) {
    margin: var(--space-3) 0;
    padding-left: var(--space-5);
  }
  .markdown :global(li) {
    margin: var(--space-1) 0;
  }
  .markdown :global(li::marker) {
    color: var(--text-muted);
  }
  .markdown :global(ul ul),
  .markdown :global(ul ol),
  .markdown :global(ol ul),
  .markdown :global(ol ol) {
    margin: var(--space-1) 0;
  }

  /* Links are interactive, so the amber accent earns its place here; underlined for affordance. */
  .markdown :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    text-decoration-color: var(--accent-line);
  }
  .markdown :global(a:hover) {
    color: var(--accent-hover);
    text-decoration-color: currentColor;
  }

  /* Inline code — a subtle mono chip (matches tool/data styling). `pre > code` is excluded (block code). */
  .markdown :global(:not(pre) > code) {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0.1em 0.35em;
    border-radius: var(--radius-sm);
    background: var(--bg-muted);
    color: var(--text);
    word-break: break-word;
  }

  /* Code blocks — a welded panel. Shiki colors the tokens; the tokens own the container (override Shiki's
     inline background so the panel matches the surface). */
  .markdown :global(pre) {
    margin: var(--space-3) 0;
    padding: var(--space-3);
    background: var(--bg) !important;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow-x: auto;
    font-size: var(--text-xs);
    line-height: var(--lh-sm);
  }
  .markdown :global(pre code) {
    font-family: var(--font-mono);
    background: none;
    padding: 0;
    font-size: inherit;
    color: var(--syntax-plain);
  }

  .markdown :global(blockquote) {
    margin: var(--space-3) 0;
    padding-left: var(--space-3);
    border-left: 2px solid var(--border-strong);
    color: var(--text-secondary);
  }

  .markdown :global(table) {
    margin: var(--space-3) 0;
    border-collapse: collapse;
    width: 100%;
    font-size: var(--text-sm);
  }
  .markdown :global(th),
  .markdown :global(td) {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border);
    text-align: left;
  }
  .markdown :global(th) {
    background: var(--bg-muted);
    font-weight: 600;
    color: var(--text);
  }

  .markdown :global(hr) {
    margin: var(--space-4) 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .markdown :global(img) {
    max-width: 100%;
    border-radius: var(--radius-sm);
  }
</style>
