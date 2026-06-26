<script lang="ts">
  import { toHighlightLanguage } from '$lib/highlight';
  import { parseMessageContent } from '$lib/message-content';

  import Code from './Code.svelte';

  /**
   * Renders one agent/user message (Phase 4 T10): prose flows as text, inline `code` gets a subtle mono
   * chip, and fenced blocks render highlighted via {@link Code}. Segmentation is the pure
   * `parseMessageContent` ($lib/message-content); this stays a thin renderer. Each prose span owns its own
   * `pre-wrap` so the container can collapse template whitespace (no stray indentation leaks in).
   */
  let { text }: { text: string } = $props();

  const segments = $derived(parseMessageContent(text));
</script>

{#each segments as segment, i (i)}{#if segment.kind === 'text'}<span class="prose">{segment.text}</span
    >{:else if segment.kind === 'inline-code'}<code class="inline">{segment.text}</code
    >{:else}<Code code={segment.code} language={toHighlightLanguage(segment.language)} />{/if}{/each}

<style>
  .prose {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .inline {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0.1em 0.35em;
    border-radius: var(--radius-sm);
    background: var(--bg-muted);
    color: var(--text);
    word-break: break-word;
  }
</style>
