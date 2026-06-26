<script lang="ts">
  import { highlight, type HighlightLanguage } from '$lib/highlight';

  /**
   * A highlighted code block (enterprise-ui §7, Phase 4 T10). Machine data, so monospace; colored by the
   * pure `highlight` lexer ($lib/highlight) into muted `--syntax-*` tokens. Lossless tokenizing means the
   * rendered spans reproduce the source exactly. The element template is intentionally whitespace-free so
   * the `<pre>` shows only the code's own whitespace, never the template's indentation.
   */
  let { code, language = 'plain' }: { code: string; language?: HighlightLanguage } = $props();

  const tokens = $derived(highlight(code, language));
</script>

<pre class="code"><code
    >{#each tokens as token, i (i)}<span data-tok={token.type}>{token.text}</span>{/each}</code
  ></pre>

<style>
  .code {
    margin: var(--space-2) 0;
    padding: var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
    color: var(--syntax-plain);
    white-space: pre;
  }
  [data-tok='keyword'] {
    color: var(--syntax-keyword);
  }
  [data-tok='string'] {
    color: var(--syntax-string);
  }
  [data-tok='number'] {
    color: var(--syntax-number);
  }
  [data-tok='comment'] {
    color: var(--syntax-comment);
    font-style: italic;
  }
  [data-tok='punctuation'] {
    color: var(--syntax-punctuation);
  }
</style>
