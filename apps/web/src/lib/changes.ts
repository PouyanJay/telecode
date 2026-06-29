import { buildFileDiff } from './diff';
import type { TranscriptEntry } from './session';

/**
 * The session-rail "Changes" summary: what files this session is touching, with real +/− line counts.
 * Every consequential file edit passes through the approval gate (architecture invariant #4), so the
 * permission entries are the authoritative record of proposed/applied changes — folding them through
 * {@link buildFileDiff} (the same model the diff card renders) yields honest totals, never invented ones.
 * A rejected gate never ran, so it is excluded; a still-pending gate is counted and surfaced as `pending`
 * ("not yet written to disk"). Pure, so the rail stays a thin renderer and this unit-tests directly.
 */
export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ChangesSummary {
  /** Distinct files touched, with edits to the same path aggregated. */
  readonly files: readonly FileChange[];
  readonly additions: number;
  readonly deletions: number;
  /** Gates still awaiting a decision — proposed but not yet written. */
  readonly pending: number;
}

/**
 * The file diff a change-bearing entry implies, or null for non-file entries. A rejected gate — or an
 * in-flight `rejecting` one, which is about to settle as rejected — never writes to disk, so it is not a
 * change; everything else (pending, approving, approved) is a proposed or applied edit.
 */
function changeDiff(entry: TranscriptEntry): ReturnType<typeof buildFileDiff> {
  if (entry.kind !== 'permission') return null;
  if (entry.decision === 'rejected' || entry.decision === 'rejecting') return null;
  return buildFileDiff(entry.toolName, entry.input);
}

export function summarizeChanges(entries: readonly TranscriptEntry[]): ChangesSummary {
  const byPath = new Map<string, { additions: number; deletions: number }>();
  let additions = 0;
  let deletions = 0;
  let pending = 0;

  for (const entry of entries) {
    if (entry.kind === 'permission' && entry.decision === 'pending') pending += 1;
    const diff = changeDiff(entry);
    if (!diff) continue;
    const acc = byPath.get(diff.path) ?? { additions: 0, deletions: 0 };
    acc.additions += diff.additions;
    acc.deletions += diff.deletions;
    byPath.set(diff.path, acc);
    additions += diff.additions;
    deletions += diff.deletions;
  }

  const files = [...byPath.entries()].map(([path, totals]) => ({ path, ...totals }));
  return { files, additions, deletions, pending };
}
