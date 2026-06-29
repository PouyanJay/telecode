import { describe, expect, it } from 'vitest';

import { summarizeChanges } from './changes';
import type { DecisionState, TranscriptEntry } from './session';

/** A permission gate entry. Fixed ids keep tests independent — the summary never asserts on them. */
function gate(
  toolName: string,
  input: Record<string, unknown>,
  decision: DecisionState = 'pending',
): TranscriptEntry {
  return { kind: 'permission', id: 'e1', requestId: 'r1', toolName, input, decision };
}

const EDIT = { file_path: 'src/a.ts', old_string: 'a\nb', new_string: 'a\nc' }; // +1 −1
const WRITE = { file_path: 'src/b.ts', content: 'x\ny' }; // +2 −0
const MULTI_EDIT = {
  file_path: 'src/c.ts',
  edits: [
    { old_string: 'a', new_string: 'b' }, // +1 −1
    { old_string: 'c', new_string: 'd\ne' }, // +2 −1
  ],
};

describe('summarizeChanges', () => {
  it('reads real +/- line counts from a pending edit gate and flags it pending', () => {
    const summary = summarizeChanges([gate('Edit', EDIT, 'pending')]);
    expect(summary.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 1 }]);
    expect(summary.additions).toBe(1);
    expect(summary.deletions).toBe(1);
    expect(summary.pending).toBe(1);
  });

  it('counts an approved write as applied (no longer pending)', () => {
    const summary = summarizeChanges([gate('Write', WRITE, 'approved')]);
    expect(summary.files).toEqual([{ path: 'src/b.ts', additions: 2, deletions: 0 }]);
    expect(summary.pending).toBe(0);
  });

  it('counts an in-flight approving gate as a change, but not as pending', () => {
    const summary = summarizeChanges([gate('Edit', EDIT, 'approving')]);
    expect(summary.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 1 }]);
    expect(summary.pending).toBe(0);
  });

  it('excludes a rejected edit and an in-flight rejecting one — neither writes to disk', () => {
    expect(summarizeChanges([gate('Edit', EDIT, 'rejected')]).files).toEqual([]);
    expect(summarizeChanges([gate('Edit', EDIT, 'rejecting')]).files).toEqual([]);
  });

  it('reads additions/deletions from a MultiEdit gate (its own hunk parser)', () => {
    const summary = summarizeChanges([gate('MultiEdit', MULTI_EDIT, 'approved')]);
    expect(summary.files).toEqual([{ path: 'src/c.ts', additions: 3, deletions: 2 }]);
  });

  it('aggregates multiple edits to the same file', () => {
    const summary = summarizeChanges([
      gate('Edit', EDIT, 'approved'),
      gate('Edit', EDIT, 'pending'),
    ]);
    expect(summary.files).toEqual([{ path: 'src/a.ts', additions: 2, deletions: 2 }]);
    expect(summary.pending).toBe(1);
  });

  it('ignores non-file gates for the diff totals but still counts them as pending', () => {
    const summary = summarizeChanges([gate('Bash', { command: 'ls' }, 'pending')]);
    expect(summary.files).toEqual([]);
    expect(summary.pending).toBe(1);
  });
});
