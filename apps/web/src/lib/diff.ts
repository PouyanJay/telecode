/**
 * Pure diff model for the diff viewer (Phase 4 T9). The session lives on the laptop; the browser is a
 * window onto it (architecture invariant #7), so a file edit reaches us only as a tool `input` — never
 * the file itself. This folds a file-mutating tool's input into a tokenized add/remove/context model the
 * Svelte `DiffView` renders verbatim. No DOM or framework coupling, so the algorithm is unit-tested
 * directly.
 *
 * Line numbers are *relative to the change* (both counters start at 1): an `Edit` carries only the edited
 * snippet (`old_string`/`new_string`), not its absolute offset in the file, so honest hunk-local numbering
 * beats inventing file positions we do not have.
 */

/** Whether a rendered line was added, removed, or is unchanged context. */
export type DiffLineKind = 'context' | 'add' | 'del';

/** One tokenized line of a file diff. A `del` has no new-side number; an `add` has no old-side number. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly oldNumber: number | null;
  readonly newNumber: number | null;
  readonly text: string;
}

/** A single file's proposed change, ready to render. */
export interface FileDiff {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly lines: readonly DiffLine[];
}

/** One before→after replacement (an `Edit`, or one entry of a `MultiEdit`). */
interface Hunk {
  readonly before: string;
  readonly after: string;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Split into lines, normalizing CRLF and dropping a single trailing newline (so it adds no phantom line). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body.split('\n');
}

/**
 * Classic LCS line diff: emit unchanged lines as `context`, removed as `del`, added as `add`, in order.
 * `dp[i][j]` is the LCS length of the suffixes `old[i..]`/`new[j..]`; the forward walk reconstructs the
 * edit script, grouping a deletion before its paired addition (the conventional unified-diff shape).
 */
function diffLines(
  oldLines: readonly string[],
  newLines: readonly string[],
): Array<{ kind: DiffLineKind; text: string }> {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  // Flat row-major LCS table, zero-initialized; `lcsAt` reads an in-range cell — the `?? 0` only
  // satisfies noUncheckedIndexedAccess, as every index below is provably in bounds.
  const width = newLength + 1;
  const lcsTable = new Int32Array((oldLength + 1) * width);
  const lcsAt = (i: number, j: number): number => lcsTable[i * width + j] ?? 0;
  for (let i = oldLength - 1; i >= 0; i--) {
    for (let j = newLength - 1; j >= 0; j--) {
      lcsTable[i * width + j] =
        oldLines[i] === newLines[j]
          ? lcsAt(i + 1, j + 1) + 1
          : Math.max(lcsAt(i + 1, j), lcsAt(i, j + 1));
    }
  }

  const ops: Array<{ kind: DiffLineKind; text: string }> = [];
  let i = 0;
  let j = 0;
  // The index is always in range inside each guard, so the line reads are non-null by construction.
  while (i < oldLength && j < newLength) {
    const before = oldLines[i]!;
    const after = newLines[j]!;
    if (before === after) {
      ops.push({ kind: 'context', text: before });
      i++;
      j++;
    } else if (lcsAt(i + 1, j) >= lcsAt(i, j + 1)) {
      ops.push({ kind: 'del', text: before });
      i++;
    } else {
      ops.push({ kind: 'add', text: after });
      j++;
    }
  }
  while (i < oldLength) ops.push({ kind: 'del', text: oldLines[i++]! });
  while (j < newLength) ops.push({ kind: 'add', text: newLines[j++]! });
  return ops;
}

/** Number a flat op list with two running counters and tally the add/del totals. */
function toFileDiff(path: string, hunks: readonly Hunk[]): FileDiff {
  const lines: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const op of diffLines(splitLines(hunk.before), splitLines(hunk.after))) {
      if (op.kind === 'context') {
        oldNumber++;
        newNumber++;
        lines.push({ kind: 'context', oldNumber, newNumber, text: op.text });
      } else if (op.kind === 'del') {
        oldNumber++;
        deletions++;
        lines.push({ kind: 'del', oldNumber, newNumber: null, text: op.text });
      } else {
        newNumber++;
        additions++;
        lines.push({ kind: 'add', oldNumber: null, newNumber, text: op.text });
      }
    }
  }

  return { path, additions, deletions, lines };
}

/** Read the `edits` array of a `MultiEdit` input into hunks; returns null unless every entry is well-formed. */
function multiEditHunks(input: Record<string, unknown>): Hunk[] | null {
  const raw = input.edits;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const hunks: Hunk[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { old_string: before, new_string: after } = entry as Record<string, unknown>;
    if (!isString(before) || !isString(after)) return null;
    hunks.push({ before, after });
  }
  return hunks;
}

/**
 * Fold a file-mutating tool's input into a renderable {@link FileDiff}, or null when the tool does not edit
 * a file or its input is malformed (the caller falls back to the raw-input view). Handles `Edit`,
 * `MultiEdit`, and `Write` (an all-additions diff — the prior content is not on the wire).
 */
export function buildFileDiff(toolName: string, input: Record<string, unknown>): FileDiff | null {
  const path = input.file_path;
  if (!isString(path)) return null;

  switch (toolName) {
    case 'Edit': {
      const { old_string: before, new_string: after } = input;
      if (!isString(before) || !isString(after)) return null;
      return toFileDiff(path, [{ before, after }]);
    }
    case 'MultiEdit': {
      const hunks = multiEditHunks(input);
      return hunks ? toFileDiff(path, hunks) : null;
    }
    case 'Write': {
      const { content } = input;
      if (!isString(content)) return null;
      return toFileDiff(path, [{ before: '', after: content }]);
    }
    default:
      return null;
  }
}
