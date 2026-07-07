import type { SessionChangesPayload } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { changesView, summarizeChanges } from './changes';
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

/**
 * `changesView` (branch-actions T1): the rail's single source for the CHANGES section. A sealed
 * branch-diff summary from the daemon is authoritative when present — even when EMPTY, because for a
 * launched session "no drift vs base" is the truth, and gate-derived counts would double-report.
 * Without one (adopted sessions, older daemons), the gate-derived summary stays the honest fallback.
 */
describe('changesView', () => {
  const branchSummary: SessionChangesPayload = {
    baseBranch: 'origin/main',
    files: [
      { path: 'src/app.ts', additions: 5, deletions: 2 },
      { path: 'assets/logo.png', additions: null, deletions: null },
    ],
    totalAdditions: 5,
    totalDeletions: 2,
    truncated: false,
  };

  it('prefers the sealed branch diff and carries its base + null counts through', () => {
    const view = changesView(branchSummary, [gate('Edit', EDIT, 'approved')]);
    expect(view.source).toBe('branch');
    expect(view.baseBranch).toBe('origin/main');
    expect(view.files).toEqual(branchSummary.files);
    expect(view.additions).toBe(5);
    expect(view.deletions).toBe(2);
    expect(view.pending).toBe(0);
  });

  it('treats an EMPTY branch diff as authoritative (never falls back to gate counts)', () => {
    const empty: SessionChangesPayload = {
      baseBranch: 'main',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    };
    const view = changesView(empty, [gate('Edit', EDIT, 'approved')]);
    expect(view.source).toBe('branch');
    expect(view.files).toEqual([]);
  });

  it('falls back to the gate-derived summary when no branch diff exists', () => {
    const view = changesView(undefined, [gate('Edit', EDIT, 'pending')]);
    expect(view.source).toBe('gates');
    expect(view.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 1 }]);
    expect(view.pending).toBe(1);
    expect(view.baseBranch).toBeUndefined();
  });
});
