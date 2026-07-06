import type { DiffStat } from '@telecode/protocol';

/**
 * Gate diff stats (mockup §01-4): a rough ±lines for an Edit/Write permission request, computed at
 * gate time so a routine call is decidable straight from the inbox card. A MULTISET line diff —
 * order-insensitive and cheap; honest for a glance, never claimed to be a minimal patch. Anything
 * this can't stat (other tools, malformed input, an unreadable target) yields undefined: the card
 * simply shows no ± rather than a wrong one.
 */
export function diffStatFromStrings(oldText: string, newText: string): DiffStat {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
      common += 1;
    }
  }
  return { added: newLines.length - common, removed: oldLines.length - common };
}

/** An empty text is zero lines, not one empty line. */
function toLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/**
 * The stat for one tool request, or undefined when it can't be computed. `readFile` is injected
 * (returns null for a missing file) so the Write branch stays testable without a filesystem.
 */
export async function diffStatForTool(
  toolName: string,
  input: Record<string, unknown>,
  readFile: (path: string) => Promise<string | null>,
): Promise<DiffStat | undefined> {
  // Deliberately Edit/Write only for now — the other EDIT_TOOLS (MultiEdit, NotebookEdit; see
  // permission-policy.ts) carry structured inputs a ±lines heuristic would misrepresent.
  try {
    if (toolName === 'Edit') {
      const { old_string: oldString, new_string: newString } = input;
      if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined;
      return diffStatFromStrings(oldString, newString);
    }
    if (toolName === 'Write') {
      const { file_path: filePath, content } = input;
      if (typeof filePath !== 'string' || typeof content !== 'string') return undefined;
      const existing = await readFile(filePath);
      return diffStatFromStrings(existing ?? '', content);
    }
    return undefined;
  } catch {
    return undefined;
  }
}
