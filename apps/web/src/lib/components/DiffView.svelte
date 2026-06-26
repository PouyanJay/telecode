<script lang="ts">
  import type { FileDiff } from '$lib/diff';

  /**
   * The diff viewer (enterprise-ui §7, Phase 4 T9): a proposed file change rendered as a tokenized
   * add/remove/context diff. Machine data, so everything is monospace. The `+`/`−`/space sign glyph
   * conveys add/del/context independent of color (never color alone), and the whole block is a labelled
   * figure announcing the file and its change counts. The diff *model* is built by the pure
   * `buildFileDiff` ($lib/diff) — this stays a thin renderer.
   */
  let { diff }: { diff: FileDiff } = $props();

  const SIGN = { add: '+', del: '−', context: ' ' } as const;

  function plural(n: number, unit: string): string {
    return `${n} ${unit}${n === 1 ? '' : 's'}`;
  }

  const summary = $derived(`Diff for ${diff.path}: ${plural(diff.additions, 'addition')}, ${plural(diff.deletions, 'deletion')}`);
</script>

<figure class="diff" aria-label={summary}>
  <figcaption class="fname">
    <span class="path" title={diff.path}>{diff.path}</span>
    <span class="counts" aria-hidden="true">
      <span class="add">+{diff.additions}</span>
      <span class="del">−{diff.deletions}</span>
    </span>
  </figcaption>

  <div class="lines">
    {#each diff.lines as line, i (i)}
      <div class="ln" data-kind={line.kind}>
        <span class="gut" aria-hidden="true">{line.newNumber ?? line.oldNumber ?? ''}</span>
        <span class="sign" aria-hidden="true">{SIGN[line.kind]}</span>
        <code class="code">{line.text}</code>
      </div>
    {/each}
  </div>
</figure>

<style>
  .diff {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--lh-xs);
  }
  .fname {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-secondary);
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .counts {
    margin-left: auto;
    display: flex;
    gap: var(--space-2);
    flex: none;
  }
  .counts .add {
    color: var(--success);
  }
  .counts .del {
    color: var(--danger);
  }
  .lines {
    overflow-x: auto;
  }
  .ln {
    display: flex;
    align-items: baseline;
  }
  .gut {
    flex: none;
    width: 3ch;
    padding-inline: var(--space-2) var(--space-1);
    text-align: right;
    color: var(--text-muted);
    user-select: none;
  }
  .sign {
    flex: none;
    width: 1.5ch;
    text-align: center;
    color: var(--text-muted);
    user-select: none;
  }
  .code {
    flex: 1;
    white-space: pre;
    color: var(--text-secondary);
    padding-right: var(--space-3);
  }
  .ln[data-kind='add'] {
    background: var(--success-soft);
  }
  .ln[data-kind='add'] .code,
  .ln[data-kind='add'] .sign {
    color: var(--success);
  }
  .ln[data-kind='del'] {
    background: var(--danger-soft);
  }
  .ln[data-kind='del'] .code,
  .ln[data-kind='del'] .sign {
    color: var(--danger);
  }
</style>
