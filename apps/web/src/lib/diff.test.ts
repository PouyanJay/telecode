import { describe, expect, it } from 'vitest';

import { buildFileDiff } from './diff';

/**
 * The diff model is the load-bearing, framework-free half of the diff viewer (T9): it folds a
 * file-mutating tool's `input` into a tokenized add/remove/context model the Svelte component renders
 * verbatim. Tested directly here so the algorithm (line-level LCS, numbering, counts) is proven without
 * a DOM. The `.svelte` renderer stays thin.
 */
describe('buildFileDiff', () => {
  it('returns null for a non-mutating tool', () => {
    expect(buildFileDiff('Read', { file_path: 'src/a.ts' })).toBeNull();
    expect(buildFileDiff('Bash', { command: 'ls' })).toBeNull();
  });

  it('returns null when an Edit is missing its strings', () => {
    expect(buildFileDiff('Edit', { file_path: 'src/a.ts' })).toBeNull();
  });

  it('diffs an Edit into context / del / add lines with running line numbers', () => {
    const diff = buildFileDiff('Edit', {
      file_path: 'src/webhooks/stripe.ts',
      old_string: "switch (event.type) {\n  case 'paid':\n    return ack();\n  default:",
      new_string:
        "switch (event.type) {\n  case 'paid':\n    return onPaid(event);\n  case 'refunded':\n    return onRefund(event);\n  default:",
    });

    expect(diff).not.toBeNull();
    expect(diff?.path).toBe('src/webhooks/stripe.ts');
    expect(diff?.additions).toBe(3);
    expect(diff?.deletions).toBe(1);

    const kinds = diff?.lines.map((l) => l.kind);
    expect(kinds).toEqual(['context', 'context', 'del', 'add', 'add', 'add', 'context']);

    // Context lines carry both numbers; a del has no new number; an add has no old number.
    const firstContext = diff?.lines[0];
    expect(firstContext).toMatchObject({
      oldNumber: 1,
      newNumber: 1,
      text: 'switch (event.type) {',
    });
    const del = diff?.lines.find((l) => l.kind === 'del');
    expect(del).toMatchObject({ oldNumber: 3, newNumber: null, text: '    return ack();' });
    const firstAdd = diff?.lines.find((l) => l.kind === 'add');
    expect(firstAdd).toMatchObject({
      oldNumber: null,
      newNumber: 3,
      text: '    return onPaid(event);',
    });
  });

  it('treats a Write as an all-additions diff (no prior content known)', () => {
    const diff = buildFileDiff('Write', { file_path: 'README.md', content: 'one\ntwo\n' });
    expect(diff?.path).toBe('README.md');
    expect(diff?.deletions).toBe(0);
    expect(diff?.additions).toBe(2);
    expect(diff?.lines.map((l) => l.kind)).toEqual(['add', 'add']);
    expect(diff?.lines.map((l) => l.text)).toEqual(['one', 'two']);
    // A trailing newline must not produce a phantom empty line.
    expect(diff?.lines).toHaveLength(2);
  });

  it('concatenates every hunk of a MultiEdit', () => {
    const diff = buildFileDiff('MultiEdit', {
      file_path: 'src/a.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b', new_string: 'B' },
      ],
    });
    expect(diff?.additions).toBe(2);
    expect(diff?.deletions).toBe(2);
    expect(diff?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'del:a',
      'add:A',
      'del:b',
      'add:B',
    ]);
  });

  it('normalizes CRLF so line endings do not leak into the diff', () => {
    const diff = buildFileDiff('Write', { file_path: 'a.txt', content: 'x\r\ny' });
    expect(diff?.lines.map((l) => l.text)).toEqual(['x', 'y']);
  });

  it('ignores a NotebookEdit (out of scope) and a malformed input', () => {
    expect(buildFileDiff('NotebookEdit', { notebook_path: 'a.ipynb' })).toBeNull();
    expect(buildFileDiff('Edit', { file_path: 5, old_string: 'a', new_string: 'b' })).toBeNull();
  });
});
